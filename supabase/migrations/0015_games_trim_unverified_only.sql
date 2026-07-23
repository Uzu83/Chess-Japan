-- 0015: 200件 trim は unverified AI のみ（verified / PvP を消して冪等を壊さない）
-- Codex data cycle-30
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

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
  v_day integer;
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

  select count(*) into v_day from public.games
   where user_id = v_uid and created_at > now() - interval '1 day';
  if v_day >= 100 then
    raise exception 'rate limited: daily game save quota';
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

  -- unverified AI のみ刈る（verified / PvP は保持）
  select count(*) into v_total from public.games
   where user_id = v_uid and mode = 'ai' and trust_level = 'unverified';
  if v_total > 200 then
    delete from public.games
     where id in (
       select id from public.games
        where user_id = v_uid and mode = 'ai' and trust_level = 'unverified'
        order by created_at asc
        limit (v_total - 200)
     );
  end if;

  return v_row;
end;
$$;

revoke all on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb, text
) to authenticated;

-- pvp_record_game の trim も同様（関数全体は 0010 定義を継承しつつ trim だけ置換）
create or replace function public.pvp_record_game(p_room_id uuid)
returns public.pvp_rooms
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
  v_record text;
  v_n integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
  end if;

  if v_room.status is distinct from 'finished' then
    raise exception 'room not finished';
  end if;

  if v_room.finish_reason is null or coalesce(v_room.authority_version, 0) < 1 then
    raise exception 'room not server-authoritative';
  end if;

  if exists (
    select 1 from public.games where user_id = v_uid and pvp_room_id = p_room_id
  ) then
    return v_room;
  end if;

  if v_uid = v_room.white_user_id then
    v_my_color := 'white';
    v_opp := v_room.black_user_id;
  else
    v_my_color := 'black';
    v_opp := v_room.white_user_id;
  end if;

  if v_room.result = '1/2-1/2' then
    v_my_outcome := 'draw';
  elsif v_room.result = '1-0' then
    v_my_outcome := case when v_my_color = 'white' then 'win' else 'loss' end;
  elsif v_room.result = '0-1' then
    v_my_outcome := case when v_my_color = 'black' then 'win' else 'loss' end;
  else
    v_my_outcome := 'unfinished';
  end if;

  v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);
  v_record := public.pvp_sans_to_pgn(v_room.moves, v_room.result);

  insert into public.games (
    user_id, game_kind, mode, trust_level,
    opponent_label, opponent_user_id, you_color,
    result, outcome, move_count, record_text, rated, pvp_room_id
  ) values (
    v_uid, v_room.game_kind, 'pvp', 'verified',
    '対人戦', v_opp, v_my_color,
    v_room.result, v_my_outcome, v_move_count, v_record, false, p_room_id
  );

  select count(*) into v_n from public.games
   where user_id = v_uid and mode = 'ai' and trust_level = 'unverified';
  if v_n > 200 then
    delete from public.games
     where id in (
       select id from public.games
        where user_id = v_uid and mode = 'ai' and trust_level = 'unverified'
        order by created_at asc
        limit (v_n - 200)
     );
  end if;

  return v_room;
end;
$$;

revoke all on function public.pvp_record_game(uuid) from public, anon, authenticated;
grant execute on function public.pvp_record_game(uuid) to authenticated;
