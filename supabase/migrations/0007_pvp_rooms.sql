-- 0007: PvP カジュアル部屋（チェス初版）
--
-- WHY サーバーで棋譜合法性を完全検証しないか（初版）:
--   Postgres に chess.js は無く、Edge を挟むと Realtime 往復が重い。
--   カジュアル MVP は「手番・所属・終局 RPC」をサーバー権威にし、指し手合法性は
--   クライアント（chess.js）で担保する。レート対象にしない（rated=false）。
--
-- Codex ゲート② F001/F005:
--   終局の games は trust_level=unverified。かつ申告者本人の行のみ書く
--   （相手の履歴への書込み・刈り込みはしない＝他人履歴破壊を防ぐ）。
--
-- explain_cache / rate_counters / apply_rated_result GRANT には触れない。

create table if not exists public.pvp_rooms (
  id uuid primary key default gen_random_uuid(),
  game_kind text not null default 'chess' check (game_kind in ('chess', 'shogi')),
  status text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished', 'aborted')),
  white_user_id uuid references auth.users (id) on delete set null,
  black_user_id uuid references auth.users (id) on delete set null,
  -- SAN/USI の配列を jsonb で保持（クライアント検証済み）
  moves jsonb not null default '[]'::jsonb,
  result text not null default '*',
  winner_color text check (winner_color is null or winner_color in ('white', 'black')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- games ↔ room 紐付け（申告者本人行の冪等キー。rooms 作成後に追加）
alter table public.games
  add column if not exists pvp_room_id uuid references public.pvp_rooms (id) on delete set null;

create unique index if not exists games_user_pvp_room_uidx
  on public.games (user_id, pvp_room_id)
  where pvp_room_id is not null;

create index if not exists pvp_rooms_waiting_idx
  on public.pvp_rooms (status, created_at)
  where status = 'waiting';

alter table public.pvp_rooms enable row level security;

-- 参加者だけ読める
create policy pvp_rooms_select_participant on public.pvp_rooms
  for select using (
    (select auth.uid()) is not null
    and (
      (select auth.uid()) = white_user_id
      or (select auth.uid()) = black_user_id
    )
  );

revoke all on table public.pvp_rooms from anon, authenticated;
grant select on table public.pvp_rooms to authenticated;

-- Realtime: supabase ダッシュボードで publication に追加が必要な場合あり（運用メモ）
comment on table public.pvp_rooms is
  'カジュアル PvP。指し手合法性はクライアント検証。'
  '終局の games 行は trust_level=unverified（サーバーが合法手/終局を検証できない MVP）。'
  'verified 昇格は Edge 検証 or 双方合意プロトコル導入後（Codex ゲート② F001）。';

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
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_game_kind is null or p_game_kind not in ('chess', 'shogi') then
    raise exception 'invalid game_kind';
  end if;
  -- 初版はチェスのみ受付（将棋はスキーマ余地のみ）
  if p_game_kind <> 'chess' then
    raise exception 'shogi pvp not enabled yet';
  end if;

  -- F004: 同一ユーザーの並列キュー作成を直列化 + 既存 waiting/active を再利用
  perform pg_advisory_xact_lock(hashtext('cj:pvp:' || v_uid::text));

  select * into v_room
    from public.pvp_rooms
   where status in ('waiting', 'active')
     and game_kind = p_game_kind
     and (white_user_id = v_uid or black_user_id = v_uid)
   order by created_at desc
   limit 1;
  if found then
    return v_room; -- 既存部屋を返す（無制限 waiting 行の増殖を防ぐ）
  end if;

  -- 作成頻度: 直近1分で新規 waiting を5超えたら拒否
  select count(*) into v_recent
    from public.pvp_rooms
   where white_user_id = v_uid
     and created_at > now() - interval '60 seconds';
  if v_recent >= 5 then
    raise exception 'rate limited: too many rooms';
  end if;

  -- 既存 waiting に黒として入る（自分以外の部屋）
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

  -- 新規部屋（自分が白）
  insert into public.pvp_rooms (game_kind, status, white_user_id)
  values (p_game_kind, 'waiting', v_uid)
  returning * into v_room;
  return v_room;
end;
$$;

revoke all on function public.pvp_join_queue(text) from public, anon;
grant execute on function public.pvp_join_queue(text) to authenticated;

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
  -- 偶数手=白、奇数手=黒
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
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_uid is distinct from v_room.white_user_id and v_uid is distinct from v_room.black_user_id then
    raise exception 'not a participant';
  end if;

  -- 既に本人行があるなら部屋状態だけ返して冪等終了（F005: 相手履歴は触らない）
  if exists (
    select 1 from public.games
     where user_id = v_uid and pvp_room_id = p_room_id
  ) then
    return v_room;
  end if;

  -- 初回申告は active のみ。相手の後追い申告は finished を許可。
  if v_room.status = 'active' then
    null; -- fall through to validate + finish
  elsif v_room.status = 'finished' then
    null; -- 相手が先に終局させた後の本人分保存
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

  -- F002: result / winner 整合。部屋が既に finished なら部屋の確定結果を優先（後追い申告の改ざん防止）
  if v_room.status = 'finished' then
    p_result := v_room.result;
    p_winner_color := v_room.winner_color;
  else
    if p_result = '1-0' and p_winner_color is distinct from 'white' then
      raise exception 'result/winner mismatch';
    end if;
    if p_result = '0-1' and p_winner_color is distinct from 'black' then
      raise exception 'result/winner mismatch';
    end if;
    if p_result = '1/2-1/2' and p_winner_color is not null then
      raise exception 'result/winner mismatch';
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

  -- F005: 申告者本人の行のみ。相手の insert/trim はしない。
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
