-- ============================================================================
-- 0009_pvp_room_quota_and_abort_scope.sql
--
-- WHY（Tier2）:
--   1) cost high: pvp_join_queue は 5/分のみで abort→再作成により pvp_rooms 無制限増殖可
--      → 日次作成上限 + aborted 7日 GC
--   2) data medium: pvp_abort が active も中断でき finalize を破壊
--      → waiting のみ abort
--   3) data high: save_unverified_ai_game に冪等キーがなく再送で重複行
--      → games.idempotency_key + unique + RPC 必須引数
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) PvP キュー: 日次上限 + GC
-- ---------------------------------------------------------------------------
create or replace function public.pvp_join_queue(p_game_kind text default 'chess')
returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.pvp_rooms;
  v_recent integer;
  v_day integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_game_kind is null or p_game_kind not in ('chess', 'shogi') then
    raise exception 'invalid game_kind';
  end if;
  if p_game_kind <> 'chess' then
    raise exception 'shogi pvp not enabled yet';
  end if;

  perform pg_advisory_xact_lock(hashtext('cj:pvp:' || v_uid::text));

  delete from public.pvp_rooms
   where id in (
     select id from public.pvp_rooms
      where status = 'aborted'
        and updated_at < now() - interval '7 days'
      order by updated_at asc
      limit 100
   );

  select * into v_room
    from public.pvp_rooms
   where status in ('waiting', 'active')
     and game_kind = p_game_kind
     and (white_user_id = v_uid or black_user_id = v_uid)
   order by created_at desc
   limit 1;
  if found then
    return v_room;
  end if;

  select count(*) into v_recent
    from public.pvp_rooms
   where white_user_id = v_uid
     and created_at > now() - interval '60 seconds';
  if v_recent >= 5 then
    raise exception 'rate limited: too many rooms';
  end if;

  select count(*) into v_day
    from public.pvp_rooms
   where white_user_id = v_uid
     and created_at > date_trunc('day', timezone('utc', now()));
  if v_day >= 30 then
    raise exception 'daily room create limit exceeded';
  end if;

  select * into v_room
    from public.pvp_rooms
   where status = 'waiting'
     and game_kind = p_game_kind
     and white_user_id is distinct from v_uid
     and black_user_id is null
   order by created_at asc
   limit 1
   for update skip locked;

  if found then
    update public.pvp_rooms
       set black_user_id = v_uid,
           status = 'active',
           updated_at = now()
     where id = v_room.id
    returning * into v_room;
    return v_room;
  end if;

  insert into public.pvp_rooms (game_kind, status, white_user_id)
  values (p_game_kind, 'waiting', v_uid)
  returning * into v_room;
  return v_room;
end;
$$;

revoke all on function public.pvp_join_queue(text) from public, anon;
grant execute on function public.pvp_join_queue(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) pvp_abort: waiting のみ
-- ---------------------------------------------------------------------------
create or replace function public.pvp_abort(p_room_id uuid)
returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.pvp_rooms;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_uid is distinct from v_room.white_user_id and v_uid is distinct from v_room.black_user_id then
    raise exception 'not a participant';
  end if;
  if v_room.status is distinct from 'waiting' then
    raise exception 'abort only allowed while waiting';
  end if;
  update public.pvp_rooms
     set status = 'aborted', updated_at = now()
   where id = p_room_id
  returning * into v_room;
  return v_room;
end;
$$;

revoke all on function public.pvp_abort(uuid) from public, anon;
grant execute on function public.pvp_abort(uuid) to authenticated;

comment on function public.pvp_join_queue(text) is
  'PvPキュー参加。5/分 + 白作成30/日 + aborted 7日GC。email確認必須。';
comment on function public.pvp_abort(uuid) is
  'waiting 部屋のみ中断。active は投了経路。email確認必須。';

-- ---------------------------------------------------------------------------
-- 3) AI戦冪等キー
-- ---------------------------------------------------------------------------
alter table public.games
  add column if not exists idempotency_key text;

create unique index if not exists games_user_idempotency_uidx
  on public.games (user_id, idempotency_key)
  where idempotency_key is not null;

drop function if exists public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
);

create or replace function public.save_unverified_ai_game(
  p_game_kind text,
  p_you_color text,
  p_outcome text,
  p_result text,
  p_move_count integer,
  p_opponent_label text,
  p_record_text text,
  p_analysis_payload jsonb default null,
  p_idempotency_key text default null
) returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.games;
  v_recent integer;
  v_total integer;
  v_expected text;
  v_key text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) < 8
     or char_length(p_idempotency_key) > 128 then
    raise exception 'invalid idempotency_key';
  end if;
  v_key := p_idempotency_key;

  if p_game_kind is null or p_game_kind not in ('chess', 'shogi') then
    raise exception 'invalid game_kind';
  end if;
  if p_you_color is null or p_you_color not in ('white', 'black') then
    raise exception 'invalid you_color';
  end if;
  if p_outcome is null or p_outcome not in ('win', 'loss', 'draw', 'unfinished') then
    raise exception 'invalid outcome';
  end if;
  if p_move_count is null or p_move_count < 0 or p_move_count > 500 then
    raise exception 'invalid move_count';
  end if;
  if p_result is null or char_length(p_result) > 16 then
    raise exception 'invalid result';
  end if;
  if p_opponent_label is null or char_length(p_opponent_label) > 80 then
    raise exception 'invalid opponent_label';
  end if;
  if p_record_text is null or octet_length(p_record_text) > 16384 then
    raise exception 'record_text too large';
  end if;

  if p_outcome = 'unfinished' then
    if p_result is distinct from '*' then raise exception 'result/outcome mismatch'; end if;
  elsif p_result in ('1-0', '0-1', '1/2-1/2') then
    if p_result = '1/2-1/2' then
      v_expected := 'draw';
    elsif p_result = '1-0' then
      v_expected := case when p_you_color = 'white' then 'win' else 'loss' end;
    else
      v_expected := case when p_you_color = 'black' then 'win' else 'loss' end;
    end if;
    if p_outcome is distinct from v_expected then raise exception 'result/outcome mismatch'; end if;
  end if;

  if p_analysis_payload is not null then
    if octet_length(p_analysis_payload::text) > 65536 then
      raise exception 'analysis_payload too large';
    end if;
    if jsonb_typeof(p_analysis_payload -> 'plies') = 'array' then
      if jsonb_array_length(p_analysis_payload -> 'plies') > 500 then
        raise exception 'too many analysis plies';
      end if;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('cj:games:' || v_uid::text));

  select * into v_row from public.games
   where user_id = v_uid and idempotency_key = v_key;
  if found then return v_row; end if;

  select count(*) into v_recent from public.games
   where user_id = v_uid and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then
    raise exception 'rate limited: too many games saved in the last minute';
  end if;

  begin
    insert into public.games (
      user_id, game_kind, mode, trust_level,
      opponent_label, opponent_user_id, you_color,
      result, outcome, move_count, record_text, analysis_payload, rated,
      idempotency_key
    ) values (
      v_uid, p_game_kind, 'ai', 'unverified',
      p_opponent_label, null, p_you_color,
      p_result, p_outcome, p_move_count, p_record_text, p_analysis_payload, false,
      v_key
    )
    returning * into v_row;
  exception when unique_violation then
    select * into v_row from public.games
     where user_id = v_uid and idempotency_key = v_key;
  end;

  select count(*) into v_total from public.games where user_id = v_uid;
  if v_total > 200 then
    delete from public.games
     where id in (
       select id from public.games
        where user_id = v_uid
        order by created_at asc
        limit (v_total - 200)
     );
  end if;

  return v_row;
end;
$$;

revoke all on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb, text
) from public, anon;
grant execute on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb, text
) to authenticated;

comment on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb, text
) is
  'AI戦 unverified 保存。idempotency_key 必須で再送冪等。email確認必須。';

-- ---------------------------------------------------------------------------
-- 4) pvp_finalize: finished 後追いは room.result と一致必須（双方勝利の矛盾防止）
--    案A維持: room 結果を黙って継承せず、一致しない申告は拒否。
-- ---------------------------------------------------------------------------
create or replace function public.pvp_finalize(
  p_room_id uuid,
  p_result text,
  p_winner_color text,
  p_record_text text
) returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.pvp_rooms;
  v_my_color text;
  v_my_outcome text;
  v_opp uuid;
  v_move_count integer;
  v_n integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_uid is distinct from v_room.white_user_id and v_uid is distinct from v_room.black_user_id then
    raise exception 'not a participant';
  end if;

  if exists (
    select 1 from public.games
     where user_id = v_uid and pvp_room_id = p_room_id
  ) then
    return v_room;
  end if;

  if v_room.status = 'active' then
    null;
  elsif v_room.status = 'finished' then
    null;
  else
    raise exception 'room not active';
  end if;

  if v_room.white_user_id is null or v_room.black_user_id is null then
    raise exception 'room incomplete';
  end if;
  if p_result is null or p_result not in ('1-0', '0-1', '1/2-1/2') then
    raise exception 'invalid result';
  end if;
  if p_winner_color is not null and p_winner_color not in ('white', 'black') then
    raise exception 'invalid winner';
  end if;
  if p_record_text is null or octet_length(p_record_text) > 16384 then
    raise exception 'record too large';
  end if;

  if p_result = '1-0' and p_winner_color is distinct from 'white' then
    raise exception 'result/winner mismatch';
  end if;
  if p_result = '0-1' and p_winner_color is distinct from 'black' then
    raise exception 'result/winner mismatch';
  end if;
  if p_result = '1/2-1/2' and p_winner_color is not null then
    raise exception 'result/winner mismatch';
  end if;

  -- finished 後追い: 先着申告と矛盾する結果は拒否（双方勝利を防ぐ）。
  if v_room.status = 'finished' then
    if v_room.result is not null and p_result is distinct from v_room.result then
      raise exception 'result conflicts with finished room';
    end if;
    if v_room.winner_color is distinct from p_winner_color then
      raise exception 'winner conflicts with finished room';
    end if;
  end if;

  if v_uid = v_room.white_user_id then
    v_my_color := 'white';
    v_opp := v_room.black_user_id;
  else
    v_my_color := 'black';
    v_opp := v_room.white_user_id;
  end if;

  if p_result = '1/2-1/2' then
    v_my_outcome := 'draw';
  elsif p_winner_color = v_my_color then
    v_my_outcome := 'win';
  else
    v_my_outcome := 'loss';
  end if;

  v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);

  if v_room.status = 'active' then
    update public.pvp_rooms
       set status = 'finished',
           result = p_result,
           winner_color = p_winner_color,
           updated_at = now()
     where id = p_room_id
    returning * into v_room;
  end if;

  perform pg_advisory_xact_lock(hashtext('cj:games:' || v_uid::text));
  insert into public.games (
    user_id, game_kind, mode, trust_level,
    opponent_label, opponent_user_id, you_color,
    result, outcome, move_count, record_text, rated, pvp_room_id
  ) values (
    v_uid, v_room.game_kind, 'pvp', 'unverified',
    '対人戦', v_opp, v_my_color,
    p_result, v_my_outcome, v_move_count, p_record_text, false, p_room_id
  );

  select count(*) into v_n from public.games where user_id = v_uid;
  if v_n > 200 then
    delete from public.games
     where id in (
       select id from public.games
        where user_id = v_uid
        order by created_at asc
        limit (v_n - 200)
     );
  end if;

  return v_room;
end;
$$;

revoke all on function public.pvp_finalize(uuid, text, text, text) from public, anon;
grant execute on function public.pvp_finalize(uuid, text, text, text) to authenticated;

comment on function public.pvp_finalize(uuid, text, text, text) is
  'PvP終局。案A: 本人 games のみ。finished 後追いは room.result 一致必須。email確認必須。';
