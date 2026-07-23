-- 0008: Tier2 品質ゲート cycle-1 の accept 修正 + PvP 終局モデル案A
--
-- 本番適用: 2026-07-18 オーナー GO 済み（Supabase migration name: gate_fixes_pvp_self_report）。
-- explain_cache / rate_counters / apply_rated_result GRANT には触れない。
--
-- 修正一覧:
--   1) PvP 終局 案A（オーナー決定 2026-07-18）:
--      各自が自分の結果を自己申告。room.result を後追い申告者の games に継承しない。
--      （継承すると、相手の偽申告が被害者の非公開履歴に焼かれる griefing になる）
--   2) authz-F002: pvp_submit_move / pvp_finalize / pvp_abort で email_confirmed_at 再検査
--   3) cost-F002: attach_unverified_analysis は analysis_payload IS NULL の行のみ（一度だけ添付）
--   4) data-F002: save_unverified_ai_game で chess 風 result と outcome/you_color の整合を強制

-- ---------------------------------------------------------------------------
-- 1) save_unverified_ai_game — result/outcome/you_color 整合（data-F002）
-- ---------------------------------------------------------------------------
create or replace function public.save_unverified_ai_game(
  p_game_kind text,
  p_you_color text,
  p_outcome text,
  p_result text,
  p_move_count integer,
  p_opponent_label text,
  p_record_text text,
  p_analysis_payload jsonb default null
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
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

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

  -- data-F002: unfinished は '*' 固定。chess 風 result は you_color から outcome を導出して照合。
  -- 将棋など他表記の result は列挙に乗らないので、outcome との厳密照合は chess 風のときだけ。
  if p_outcome = 'unfinished' then
    if p_result is distinct from '*' then
      raise exception 'result/outcome mismatch';
    end if;
  elsif p_result in ('1-0', '0-1', '1/2-1/2') then
    if p_result = '1/2-1/2' then
      v_expected := 'draw';
    elsif p_result = '1-0' then
      v_expected := case when p_you_color = 'white' then 'win' else 'loss' end;
    else
      v_expected := case when p_you_color = 'black' then 'win' else 'loss' end;
    end if;
    if p_outcome is distinct from v_expected then
      raise exception 'result/outcome mismatch';
    end if;
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

  select count(*) into v_recent
    from public.games
   where user_id = v_uid
     and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then
    raise exception 'rate limited: too many games saved in the last minute';
  end if;

  insert into public.games (
    user_id, game_kind, mode, trust_level,
    opponent_label, opponent_user_id, you_color,
    result, outcome, move_count, record_text, analysis_payload, rated
  ) values (
    v_uid, p_game_kind, 'ai', 'unverified',
    p_opponent_label, null, p_you_color,
    p_result, p_outcome, p_move_count, p_record_text, p_analysis_payload, false
  )
  returning * into v_row;

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
  text, text, text, text, integer, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) attach_unverified_analysis — 一度だけ添付（cost-F002）
-- ---------------------------------------------------------------------------
create or replace function public.attach_unverified_analysis(
  p_game_id uuid,
  p_analysis_payload jsonb
) returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.games;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_game_id is null then
    raise exception 'invalid game_id';
  end if;
  if p_analysis_payload is null then
    raise exception 'analysis_payload required';
  end if;

  if octet_length(p_analysis_payload::text) > 65536 then
    raise exception 'analysis_payload too large';
  end if;
  if jsonb_typeof(p_analysis_payload -> 'plies') = 'array' then
    if jsonb_array_length(p_analysis_payload -> 'plies') > 500 then
      raise exception 'too many analysis plies';
    end if;
  end if;

  -- cost-F002: analysis_payload IS NULL の行だけ更新（再送・並列上書きによる WAL/帯域濫用を防ぐ）。
  -- 既添付の再解析は別 RPC を将来用意するまで拒否（同じ『game not found』で列挙防止）。
  update public.games
     set analysis_payload = p_analysis_payload
   where id = p_game_id
     and user_id = v_uid
     and trust_level = 'unverified'
     and mode = 'ai'
     and analysis_payload is null
  returning * into v_row;

  if not found then
    raise exception 'game not found';
  end if;
  return v_row;
end;
$$;

revoke all on function public.attach_unverified_analysis(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.attach_unverified_analysis(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) pvp_submit_move — email 再検査（authz-F002）
-- ---------------------------------------------------------------------------
create or replace function public.pvp_submit_move(p_room_id uuid, p_san text)
returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.pvp_rooms;
  v_len integer;
  v_expected uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_san is null or char_length(p_san) < 2 or char_length(p_san) > 16 then
    raise exception 'invalid san';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;
  if v_uid is distinct from v_room.white_user_id and v_uid is distinct from v_room.black_user_id then
    raise exception 'not a participant';
  end if;

  v_len := coalesce(jsonb_array_length(v_room.moves), 0);
  v_expected := case when v_len % 2 = 0 then v_room.white_user_id else v_room.black_user_id end;
  if v_uid is distinct from v_expected then
    raise exception 'not your turn';
  end if;
  if v_len >= 500 then raise exception 'too many moves'; end if;

  update public.pvp_rooms
     set moves = v_room.moves || jsonb_build_array(p_san),
         updated_at = now()
   where id = p_room_id
  returning * into v_room;
  return v_room;
end;
$$;

revoke all on function public.pvp_submit_move(uuid, text) from public, anon;
grant execute on function public.pvp_submit_move(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) pvp_finalize — 案A + email 再検査（authz-F001/F002, data-F001）
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

  -- 既に本人行があるなら冪等終了（相手履歴は触らない）
  if exists (
    select 1 from public.games
     where user_id = v_uid and pvp_room_id = p_room_id
  ) then
    return v_room;
  end if;

  if v_room.status = 'active' then
    null;
  elsif v_room.status = 'finished' then
    null; -- 後追い本人分。room.result は継承しない（案A）
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

  -- 案A: 常に申告者の p_result / p_winner_color を使う（room 結果で上書きしない）。
  -- room.result は「先に申告した側の表示用メモ」であり、相手の games 行の権威ではない。
  if p_result = '1-0' and p_winner_color is distinct from 'white' then
    raise exception 'result/winner mismatch';
  end if;
  if p_result = '0-1' and p_winner_color is distinct from 'black' then
    raise exception 'result/winner mismatch';
  end if;
  if p_result = '1/2-1/2' and p_winner_color is not null then
    raise exception 'result/winner mismatch';
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

  -- 先着の申告で着手を止めるため room を finished にする。
  -- ただし後追い側の games にはこの result を強制しない（案A）。
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

-- ---------------------------------------------------------------------------
-- 5) pvp_abort — email 再検査（authz-F002）
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
  if v_room.status = 'finished' then return v_room; end if;
  update public.pvp_rooms
     set status = 'aborted', updated_at = now()
   where id = p_room_id
  returning * into v_room;
  return v_room;
end;
$$;

revoke all on function public.pvp_abort(uuid) from public, anon;
grant execute on function public.pvp_abort(uuid) to authenticated;

comment on function public.pvp_finalize(uuid, text, text, text) is
  'PvP終局。案A: 申告者本人の games のみ。room.result は後追い側に継承しない。'
  'trust_level=unverified。email確認必須。';
