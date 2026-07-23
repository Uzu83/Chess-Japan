-- 0010: PvP サーバー権威（合法手は Edge+chess.js、終局・投了・タイムアウトは DB）
--
-- A0 監査反映:
--   - 旧 pvp_submit_move / pvp_finalize は exact signature で REVOKE→DROP
--   - 着手書き込みは service_role 専用 pvp_apply_move（FOR UPDATE・手数一致）
--   - 公開 Strength / 20局は trust_level=verified のみ
--   - heartbeat は liveness（人間証明ではない）。手番タイムアウトで固着を防ぐ
--
-- 触らない: explain_cache / rate_counters の RLS・GRANT、apply_rated_result GRANT

-- ---------------------------------------------------------------------------
-- 1) スキーマ拡張
-- ---------------------------------------------------------------------------
alter table public.pvp_rooms
  add column if not exists fen text
    not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  add column if not exists white_last_seen timestamptz,
  add column if not exists black_last_seen timestamptz,
  add column if not exists turn_started_at timestamptz,
  add column if not exists finish_reason text
    check (
      finish_reason is null
      or finish_reason in (
        'checkmate', 'stalemate', 'insufficient', 'threefold', 'fiftyMove',
        'resign', 'timeout', 'abandon'
      )
    ),
  add column if not exists authority_version integer not null default 0;

-- WHY 既存 waiting/active を一括 abort するか（Codex data cycle-13 F001）:
--   旧 pvp_submit_move / pvp_finalize は本 migration で DROP し、新 pvp_apply_move は
--   authority_version<1 を拒否する。0 のまま残すと進行中対局は着手も終局もできず
--   固着する。再キュー時 abort だけだと「途中放棄」と同じなので、適用時点で明示
--   abort し、新規マッチは authority_version=1 から始める。
--   旧 finished（finish_reason NULL）は verified record 対象外のまま（意図どおり）。
update public.pvp_rooms
   set status = 'aborted',
       finish_reason = coalesce(finish_reason, 'abandon'),
       updated_at = now()
 where status in ('waiting', 'active')
   and coalesce(authority_version, 0) < 1;

comment on column public.pvp_rooms.authority_version is
  '0=旧クライアント権威時代（0010 適用時に waiting/active は abort 済み）。1+=サーバー権威。';

comment on table public.pvp_rooms is
  'カジュアル PvP。着手合法性は Edge+chess.js。終局はサーバー導出。'
  'games 記録は verified（0010 以降のサーバー権威終局）。旧自己申告経路は DROP 済み。';

-- ---------------------------------------------------------------------------
-- 2) 簡易 PGN 組み立て（record_text サーバー生成用）
-- ---------------------------------------------------------------------------
create or replace function public.pvp_sans_to_pgn(p_moves jsonb, p_result text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_n integer;
  v_i integer;
  v_parts text := '';
  v_san text;
  v_result text := coalesce(nullif(p_result, ''), '*');
begin
  if p_moves is null or jsonb_typeof(p_moves) <> 'array' then
    return '[Result "' || v_result || '"]' || E'\n\n' || v_result || E'\n';
  end if;
  v_n := jsonb_array_length(p_moves);
  for v_i in 0 .. greatest(v_n - 1, -1) loop
    v_san := p_moves ->> v_i;
    if v_i % 2 = 0 then
      if v_parts <> '' then v_parts := v_parts || ' '; end if;
      v_parts := v_parts || ((v_i / 2) + 1)::text || '. ' || coalesce(v_san, '?');
    else
      v_parts := v_parts || ' ' || coalesce(v_san, '?');
    end if;
  end loop;
  return '[Result "' || v_result || '"]' || E'\n\n'
    || trim(v_parts) || case when v_parts <> '' then ' ' else '' end || v_result || E'\n';
end;
$$;

revoke all on function public.pvp_sans_to_pgn(jsonb, text) from public, anon, authenticated;
grant execute on function public.pvp_sans_to_pgn(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3) タイムアウト適用（接続断 90s / 手番 300s）。DB now() のみ。
-- ---------------------------------------------------------------------------
create or replace function public.pvp_apply_timeouts(p_room_id uuid)
returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms;
  v_move_count integer;
  v_turn text;
  v_opp_seen timestamptz;
  v_loser text;
  v_winner text;
begin
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status is distinct from 'active' then
    return v_room;
  end if;

  v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);
  v_turn := case when v_move_count % 2 = 0 then 'white' else 'black' end;

  -- 手番タイムアウト（着手義務。heartbeat では逃げられない）
  if v_room.turn_started_at is not null
     and v_room.turn_started_at < now() - interval '300 seconds' then
    v_loser := v_turn;
    v_winner := case when v_loser = 'white' then 'black' else 'white' end;
    update public.pvp_rooms
       set status = 'finished',
           result = case when v_winner = 'white' then '1-0' else '0-1' end,
           winner_color = v_winner,
           finish_reason = 'timeout',
           updated_at = now()
     where id = p_room_id
    returning * into v_room;
    return v_room;
  end if;

  -- 相手接続断（自色の last_seen は触らない前提で「相手」を見る）
  -- 呼び出し者がどちらでも、手番側でない相手が消えていれば手番側勝利…ではなく
  -- 「last_seen が古い側」を敗者にする（公平: どちらが RPC を呼んでも同じ判定）。
  if v_room.white_last_seen is not null and v_room.black_last_seen is not null then
    if v_room.white_last_seen < now() - interval '90 seconds'
       and v_room.white_last_seen <= v_room.black_last_seen then
      v_loser := 'white';
    elsif v_room.black_last_seen < now() - interval '90 seconds'
       and v_room.black_last_seen <= v_room.white_last_seen then
      v_loser := 'black';
    else
      v_loser := null;
    end if;
    if v_loser is not null then
      v_winner := case when v_loser = 'white' then 'black' else 'white' end;
      update public.pvp_rooms
         set status = 'finished',
             result = case when v_winner = 'white' then '1-0' else '0-1' end,
             winner_color = v_winner,
             finish_reason = 'timeout',
               updated_at = now()
       where id = p_room_id
      returning * into v_room;
      return v_room;
    end if;
  end if;

  return v_room;
end;
$$;

revoke all on function public.pvp_apply_timeouts(uuid) from public, anon, authenticated;
grant execute on function public.pvp_apply_timeouts(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4) 停滞室 GC
-- ---------------------------------------------------------------------------
create or replace function public.pvp_gc_stale_rooms()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  update public.pvp_rooms
     set status = 'aborted', updated_at = now()
   where status = 'waiting'
     and created_at < now() - interval '10 minutes';

  -- 双方無応答のみ abandon 引き分け。手番 TO は heartbeat/move/resign 側
  -- （ここで apply_timeouts すると双方切断でも片側勝ちになり誤 verified）。
  update public.pvp_rooms
     set status = 'finished',
         result = '1/2-1/2',
         winner_color = null,
         finish_reason = 'abandon',
         updated_at = now()
   where status = 'active'
     and updated_at < now() - interval '10 minutes'
     and coalesce(white_last_seen, updated_at) < now() - interval '10 minutes'
     and coalesce(black_last_seen, updated_at) < now() - interval '10 minutes';

  -- aborted のみ 7日 GC。finished は未記録のみ 90 日後削除（紐付け根拠を残す）。
  delete from public.pvp_rooms
   where status = 'aborted'
     and updated_at < now() - interval '7 days';
  delete from public.pvp_rooms
   where status = 'finished'
     and updated_at < now() - interval '90 days'
     and not exists (
       select 1 from public.games g where g.pvp_room_id = pvp_rooms.id
     );
end;
$$;

-- authenticated 直叩き禁止（join_queue は SECURITY DEFINER 経由でのみ呼ぶ）
revoke all on function public.pvp_gc_stale_rooms() from public, anon, authenticated;
grant execute on function public.pvp_gc_stale_rooms() to service_role;

-- ---------------------------------------------------------------------------
-- 5) pvp_apply_move — Edge 専用（棋理は Edge 検証済みを信頼＋原子性）
-- ---------------------------------------------------------------------------
create or replace function public.pvp_apply_move(
  p_room_id uuid,
  p_actor uuid,
  p_san text,
  p_fen text,
  p_result text default '*',
  p_winner_color text default null,
  p_finish_reason text default null,
  p_expected_move_count integer default null
) returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms;
  v_move_count integer;
  v_turn text;
  v_my_color text;
  v_moves jsonb;
begin
  if p_actor is null then raise exception 'not authenticated'; end if;
  if p_san is null or char_length(p_san) < 2 or char_length(p_san) > 16 then
    raise exception 'invalid san';
  end if;
  if p_fen is null or char_length(p_fen) < 10 or char_length(p_fen) > 120 then
    raise exception 'invalid fen';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;

  v_room := public.pvp_apply_timeouts(p_room_id);
  if v_room.status is distinct from 'active' then
    return v_room;
  end if;

  if p_actor is distinct from v_room.white_user_id
     and p_actor is distinct from v_room.black_user_id then
    raise exception 'not a participant';
  end if;
  if coalesce(v_room.authority_version, 0) < 1 then
    raise exception 'legacy room; start a new match';
  end if;

  v_my_color := case when p_actor = v_room.white_user_id then 'white' else 'black' end;
  v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);
  if p_expected_move_count is null or p_expected_move_count is distinct from v_move_count then
    raise exception 'move count mismatch';
  end if;
  if v_move_count >= 500 then raise exception 'too many moves'; end if;

  v_turn := case when v_move_count % 2 = 0 then 'white' else 'black' end;
  if v_my_color is distinct from v_turn then
    raise exception 'not your turn';
  end if;

  v_moves := coalesce(v_room.moves, '[]'::jsonb) || jsonb_build_array(p_san);

  if p_result is not null and p_result in ('1-0', '0-1', '1/2-1/2') then
    if p_result = '1-0' and p_winner_color is distinct from 'white' then
      raise exception 'result/winner mismatch';
    end if;
    if p_result = '0-1' and p_winner_color is distinct from 'black' then
      raise exception 'result/winner mismatch';
    end if;
    if p_result = '1/2-1/2' and p_winner_color is not null then
      raise exception 'result/winner mismatch';
    end if;
    -- 着手経路の終局理由は棋理由来のみ（resign/timeout/abandon は専用 RPC）
    if p_finish_reason is null
       or p_finish_reason not in (
         'checkmate', 'stalemate', 'insufficient', 'threefold', 'fiftyMove'
       ) then
      raise exception 'invalid finish_reason for move';
    end if;
    update public.pvp_rooms
       set moves = v_moves,
           fen = p_fen,
           status = 'finished',
           result = p_result,
           winner_color = p_winner_color,
           finish_reason = p_finish_reason,
           white_last_seen = case when v_my_color = 'white' then now() else white_last_seen end,
           black_last_seen = case when v_my_color = 'black' then now() else black_last_seen end,
           updated_at = now()
     where id = p_room_id
    returning * into v_room;
  else
    update public.pvp_rooms
       set moves = v_moves,
           fen = p_fen,
           white_last_seen = case when v_my_color = 'white' then now() else white_last_seen end,
           black_last_seen = case when v_my_color = 'black' then now() else black_last_seen end,
           turn_started_at = now(),
           updated_at = now()
     where id = p_room_id
    returning * into v_room;
  end if;

  return v_room;
end;
$$;

revoke all on function public.pvp_apply_move(
  uuid, uuid, text, text, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.pvp_apply_move(
  uuid, uuid, text, text, text, text, text, integer
) to service_role;

comment on function public.pvp_apply_move(
  uuid, uuid, text, text, text, text, text, integer
) is
  'Edge 専用着手 commit。p_actor は Edge が JWT uid から渡すこと（body の uid 反射禁止）。'
  '棋理は Edge 検証済み。FOR UPDATE + expected_move_count で TOCTOU 防止。'
  'finish_reason は checkmate/stalemate/insufficient/threefold/fiftyMove のみ。';

-- ---------------------------------------------------------------------------
-- 6) pvp_resign / pvp_heartbeat / pvp_record_game
-- ---------------------------------------------------------------------------
create or replace function public.pvp_resign(p_room_id uuid)
returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.pvp_rooms;
  v_my_color text;
  v_winner text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  -- 不存在と非参加者は同一エラー（部屋存在オラクル防止）
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
  end if;
  -- 旧権威部屋は verified 昇格経路に乗せない（再マッチして version=1 でやり直す）
  if coalesce(v_room.authority_version, 0) < 1 then
    raise exception 'legacy room; start a new match';
  end if;
  v_room := public.pvp_apply_timeouts(p_room_id);
  if v_room.status is distinct from 'active' then
    return v_room;
  end if;

  v_my_color := case when v_uid = v_room.white_user_id then 'white' else 'black' end;
  v_winner := case when v_my_color = 'white' then 'black' else 'white' end;

  update public.pvp_rooms
     set status = 'finished',
         result = case when v_winner = 'white' then '1-0' else '0-1' end,
         winner_color = v_winner,
         finish_reason = 'resign',
         white_last_seen = case when v_my_color = 'white' then now() else white_last_seen end,
         black_last_seen = case when v_my_color = 'black' then now() else black_last_seen end,
         updated_at = now()
   where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.pvp_resign(uuid) from public, anon, authenticated;
grant execute on function public.pvp_resign(uuid) to authenticated;

create or replace function public.pvp_heartbeat(p_room_id uuid)
returns public.pvp_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.pvp_rooms;
  v_my_color text;
  v_allowed boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  -- 行ロック前に uid 単位レート（6/分）。連打で FOR UPDATE を増幅させない。
  v_allowed := public.rate_check('pvp:hb:' || v_uid::text, 6, 60);
  if not coalesce(v_allowed, false) then
    raise exception 'rate limited';
  end if;

  -- ロックなしで参加者を先に確認。不存在と非参加者は同一エラー。
  select * into v_room from public.pvp_rooms where id = p_room_id;
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
  end if;
  if v_room.status is distinct from 'active' then
    return v_room;
  end if;
  v_my_color := case when v_uid = v_room.white_user_id then 'white' else 'black' end;
  if v_my_color = 'white'
     and v_room.white_last_seen is not null
     and v_room.white_last_seen > now() - interval '10 seconds' then
    return v_room;
  end if;
  if v_my_color = 'black'
     and v_room.black_last_seen is not null
     and v_room.black_last_seen > now() - interval '10 seconds' then
    return v_room;
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  v_room := public.pvp_apply_timeouts(p_room_id);
  if v_room.status is distinct from 'active' then
    return v_room;
  end if;
  if v_uid is distinct from v_room.white_user_id and v_uid is distinct from v_room.black_user_id then
    raise exception 'not a participant';
  end if;
  v_my_color := case when v_uid = v_room.white_user_id then 'white' else 'black' end;
  if v_my_color = 'white'
     and v_room.white_last_seen is not null
     and v_room.white_last_seen > now() - interval '10 seconds' then
    return v_room;
  end if;
  if v_my_color = 'black'
     and v_room.black_last_seen is not null
     and v_room.black_last_seen > now() - interval '10 seconds' then
    return v_room;
  end if;

  update public.pvp_rooms
     set white_last_seen = case when v_my_color = 'white' then now() else white_last_seen end,
         black_last_seen = case when v_my_color = 'black' then now() else black_last_seen end,
         updated_at = now()
   where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.pvp_heartbeat(uuid) from public, anon, authenticated;
grant execute on function public.pvp_heartbeat(uuid) to authenticated;

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
  -- WHY 参加者チェックを status より先にするか（Codex authz cycle-11 F002）:
  --   非参加者に finished / authority のエラー差を返すと状態オラクルになる。
  --   不存在と非参加者は同一 'room not found' に合流させる。
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
  end if;

  if v_room.status is distinct from 'finished' then
    raise exception 'room not finished';
  end if;

  -- 旧自己申告 finished / 旧権威部屋は verified に昇格させない
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
  elsif v_room.winner_color = v_my_color then
    v_my_outcome := 'win';
  else
    v_my_outcome := 'loss';
  end if;

  v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);
  v_record := public.pvp_sans_to_pgn(v_room.moves, v_room.result);

  perform pg_advisory_xact_lock(hashtext('cj:games:' || v_uid::text));
  insert into public.games (
    user_id, game_kind, mode, trust_level,
    opponent_label, opponent_user_id, you_color,
    result, outcome, move_count, record_text, rated, pvp_room_id
  ) values (
    v_uid, v_room.game_kind, 'pvp', 'verified',
    '対人戦', v_opp, v_my_color,
    v_room.result, v_my_outcome, v_move_count, v_record, false, p_room_id
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

revoke all on function public.pvp_record_game(uuid) from public, anon, authenticated;
grant execute on function public.pvp_record_game(uuid) to authenticated;

comment on function public.pvp_record_game(uuid) is
  'finished room の本人 games を冪等保存。result/record はサーバー生成。trust_level=verified。';

-- ---------------------------------------------------------------------------
-- 7) join_queue: GC + last_seen / turn_started_at 初期化
--    （既存関数を置き換え。0009 のクォータ契約を維持）
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
  v_day_white integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_game_kind is null or p_game_kind not in ('chess', 'shogi') then
    raise exception 'invalid game_kind';
  end if;
  if p_game_kind = 'shogi' then
    raise exception 'shogi pvp not available';
  end if;

  -- WHY GC を例外経路の前に置かないか（Codex cost cycle-11 F001）:
  --   rate_check / GC の副作用は同一トランザクション内。quota/rate exception で
  --   ロールバックされると `pvp:gc:global` 消費も戻り、クォータ超過ユーザーが
  --   毎回全表 GC を再実行できる。よって raise しうる検査を先に済ませ、
  --   成功確定後だけスロットル付き GC を呼ぶ。
  select count(*) into v_recent
    from public.pvp_rooms
   where (white_user_id = v_uid or black_user_id = v_uid)
     and created_at > now() - interval '60 seconds';
  if v_recent >= 5 then
    raise exception 'rate limited: too many pvp joins';
  end if;

  perform pg_advisory_xact_lock(hashtext('cj:pvp:' || v_uid::text));

  select * into v_room
    from public.pvp_rooms
   where status in ('waiting', 'active')
     and (white_user_id = v_uid or black_user_id = v_uid)
   order by created_at desc
   limit 1;
  if found then
    -- 旧権威部屋は再利用せず abort して新規マッチへ（退出不能を防ぐ）
    if coalesce(v_room.authority_version, 0) < 1 then
      update public.pvp_rooms
         set status = 'aborted', updated_at = now()
       where id = v_room.id;
    else
      if public.rate_check('pvp:gc:global', 1, 60) then
        perform public.pvp_gc_stale_rooms();
      end if;
      return v_room;
    end if;
  end if;

  select * into v_room
    from public.pvp_rooms
   where status = 'waiting'
     and game_kind = p_game_kind
     and white_user_id is not null
     and black_user_id is null
     and white_user_id is distinct from v_uid
   order by created_at asc
   limit 1
   for update skip locked;

  if found then
    update public.pvp_rooms
       set black_user_id = v_uid,
           status = 'active',
           white_last_seen = now(),
           black_last_seen = now(),
           turn_started_at = now(),
           authority_version = 1,
           updated_at = now()
     where id = v_room.id
    returning * into v_room;
    if public.rate_check('pvp:gc:global', 1, 60) then
      perform public.pvp_gc_stale_rooms();
    end if;
    return v_room;
  end if;

  select count(*) into v_day_white
    from public.pvp_rooms
   where white_user_id = v_uid
     and created_at > now() - interval '1 day';
  if v_day_white >= 30 then
    raise exception 'rate limited: daily room create quota';
  end if;

  -- 新規 waiting 作成が確定した直後のみ GC（この先は raise しない）。
  if public.rate_check('pvp:gc:global', 1, 60) then
    perform public.pvp_gc_stale_rooms();
  end if;

  insert into public.pvp_rooms (
    game_kind, status, white_user_id, white_last_seen, turn_started_at, authority_version
  ) values (
    p_game_kind, 'waiting', v_uid, now(), now(), 1
  )
  returning * into v_room;
  return v_room;
end;
$$;

revoke all on function public.pvp_join_queue(text) from public, anon, authenticated;
grant execute on function public.pvp_join_queue(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) 旧 RPC 破棄（exact signature）
-- ---------------------------------------------------------------------------
revoke all on function public.pvp_submit_move(uuid, text) from public, anon, authenticated;
revoke all on function public.pvp_finalize(uuid, text, text, text) from public, anon, authenticated;
drop function if exists public.pvp_submit_move(uuid, text);
drop function if exists public.pvp_finalize(uuid, text, text, text);

-- ---------------------------------------------------------------------------
-- 9) 公開 Strength = verified のみ + rate_check
-- ---------------------------------------------------------------------------
create or replace function public.set_strength_visibility(
  p_visibility text,
  p_handle text default null
) returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles;
  v_handle text;
  v_game_count integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_visibility is null or p_visibility not in ('private', 'public') then
    raise exception 'invalid visibility';
  end if;

  if p_visibility = 'public' then
    v_handle := nullif(lower(trim(coalesce(p_handle, ''))), '');
    if v_handle is null or v_handle !~ '^[a-z0-9_]{3,24}$' then
      raise exception 'invalid handle';
    end if;
    -- ADR 0002 / A0: 公開フロアは verified のみ
    select count(*) into v_game_count
      from public.games
     where user_id = v_uid and trust_level = 'verified';
    if v_game_count < 20 then
      raise exception 'not enough games for a public profile';
    end if;
  else
    v_handle := null;
  end if;

  update public.profiles
     set strength_visibility = p_visibility,
         public_handle = case when p_visibility = 'public' then v_handle else null end
   where id = v_uid
  returning * into v_row;

  if not found then raise exception 'no profile'; end if;
  return v_row;
exception
  when unique_violation then
    raise exception 'handle already taken';
end;
$$;

revoke all on function public.set_strength_visibility(text, text) from public, anon, authenticated;
grant execute on function public.set_strength_visibility(text, text) to authenticated;

-- WHY STABLE にしないか: rate_check が rate_counters を書くため VOLATILE 必須。
-- STABLE のままだと書込み文脈で失敗し、例外経路で常に NULL になる（A1 accept）。
create or replace function public.get_public_strength(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handle text := nullif(lower(trim(coalesce(p_handle, ''))), '');
  v_profile public.profiles;
  v_game_count integer;
  v_games_bucket text;
  v_ip text;
  v_headers jsonb;
  v_allowed boolean;
begin
  -- IP レート（列挙スクレイピング抑止）。失敗時は非開示に倒す。
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
    v_ip := split_part(coalesce(v_headers->>'x-forwarded-for', ''), ',', 1);
    v_ip := nullif(trim(v_ip), '');
    if v_ip is null then
      v_ip := nullif(v_headers->>'cf-connecting-ip', '');
    end if;
    if v_ip is null then v_ip := 'unknown'; end if;
    v_allowed := public.rate_check('pubstr:' || v_ip, 20, 60);
    if not coalesce(v_allowed, false) then
      return null;
    end if;
  exception when others then
    return null;
  end;

  if v_handle is null or v_handle !~ '^[a-z0-9_]{3,24}$' then
    return null;
  end if;

  select * into v_profile
    from public.profiles
   where public_handle = v_handle
     and strength_visibility = 'public';
  if not found then return null; end if;

  select count(*) into v_game_count
    from public.games
   where user_id = v_profile.id and trust_level = 'verified';
  if v_game_count < 20 then return null; end if;

  v_games_bucket := case
    when v_game_count < 50 then '20-49'
    when v_game_count < 100 then '50-99'
    else '100+'
  end;

  return jsonb_build_object(
    'handle', v_profile.public_handle,
    'accuracy_bucket', 'not_available',
    'top_strengths', '[]'::jsonb,
    'top_weaknesses', '[]'::jsonb,
    'games_bucket', v_games_bucket
  );
end;
$$;

revoke all on function public.get_public_strength(text) from public, anon, authenticated;
grant execute on function public.get_public_strength(text) to anon, authenticated;

-- rate_check は service_role GRANT のみだが、SECURITY DEFINER(owner) から呼べる。
-- get_public_strength の owner が postgres 系である前提（Supabase 既定）。
