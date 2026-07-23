-- 0018: 採点ループ Top3（G002 / G003）+ Tier2 cycle-42..44 反映
--   G002: finished 遷移で両者 verified を冪等保存。欠落は GC バッチで再試行。
--   G003: 旧 8 引数互換。9 引数の default を外してオーバーロード曖昧さを解消。
--   ロック順: pvp_rooms FOR UPDATE → uid advisory（deadlock 防止）
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

-- ---------------------------------------------------------------------------
-- G002: ensure（room 行は呼び出し元がロック済みでも可。未ロックならここで取る）
-- ---------------------------------------------------------------------------
drop function if exists public.pvp_ensure_verified_records(uuid);
drop function if exists public.pvp_ensure_verified_records(uuid, boolean);

create or replace function public.pvp_ensure_verified_records(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms;
  v_uid uuid;
  v_uids uuid[];
  v_my_color text;
  v_my_outcome text;
  v_opp uuid;
  v_move_count integer;
  v_record text;
  v_day integer;
begin
  -- ロック順の第1段: room。既にロック済みなら同じ行を再取得するだけ。
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return; end if;
  if v_room.status is distinct from 'finished' then return; end if;
  if v_room.finish_reason is null or coalesce(v_room.authority_version, 0) < 1 then
    return;
  end if;
  if v_room.result is null or v_room.result not in ('1-0', '0-1', '1/2-1/2') then
    return;
  end if;

  v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);
  v_record := public.pvp_sans_to_pgn(v_room.moves, v_room.result);

  -- uid をソートして advisory 取得順を固定（相互 deadlock 防止）
  select array_agg(u order by u)
    into v_uids
    from unnest(array_remove(
      array[v_room.white_user_id, v_room.black_user_id],
      null
    )) as u;

  if v_uids is null then return; end if;

  foreach v_uid in array v_uids
  loop
    if (select email_confirmed_at from auth.users where id = v_uid) is null then
      continue;
    end if;

    if exists (
      select 1 from public.games
       where user_id = v_uid and pvp_room_id = p_room_id
    ) then
      continue;
    end if;

    -- ロック順の第2段: uid advisory（room の後）
    perform pg_advisory_xact_lock(hashtext('cj:games:' || v_uid::text));

    if exists (
      select 1 from public.games
       where user_id = v_uid and pvp_room_id = p_room_id
    ) then
      continue;
    end if;

    select count(*) into v_day from public.games
     where user_id = v_uid and mode = 'pvp' and trust_level = 'verified'
       and created_at > now() - interval '1 day';
    if v_day >= 40 then
      continue;
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
    else
      v_my_outcome := case when v_my_color = 'black' then 'win' else 'loss' end;
    end if;

    begin
      insert into public.games (
        user_id, game_kind, mode, trust_level,
        opponent_label, opponent_user_id, you_color,
        result, outcome, move_count, record_text, rated, pvp_room_id
      ) values (
        v_uid, v_room.game_kind, 'pvp', 'verified',
        '対人戦', v_opp, v_my_color,
        v_room.result, v_my_outcome, v_move_count, v_record, false, p_room_id
      );
    exception when unique_violation then
      null;
    end;
  end loop;
end;
$$;

revoke all on function public.pvp_ensure_verified_records(uuid)
  from public, anon, authenticated;
grant execute on function public.pvp_ensure_verified_records(uuid) to service_role;

comment on function public.pvp_ensure_verified_records(uuid) is
  'finished+authority の両者 verified を冪等保存。room FOR UPDATE→uid advisory。日次40厳守。'
  '超過時はスキップし room は残す（欠落 finished は GC 削除しない）。';

create or replace function public.pvp_trg_ensure_verified_records()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'finished'
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'finished') then
    perform public.pvp_ensure_verified_records(NEW.id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists pvp_rooms_ensure_verified on public.pvp_rooms;
create trigger pvp_rooms_ensure_verified
  after insert or update of status on public.pvp_rooms
  for each row
  execute function public.pvp_trg_ensure_verified_records();

-- pvp_record_game: ロック順を room → advisory に揃える（0016 は逆順だった）
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
  v_day integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  -- ロック順: room → advisory（ensure / トリガと一致 — Codex data cycle-43）
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

  perform pg_advisory_xact_lock(hashtext('cj:games:' || v_uid::text));

  if exists (
    select 1 from public.games where user_id = v_uid and pvp_room_id = p_room_id
  ) then
    return v_room;
  end if;

  select count(*) into v_day from public.games
   where user_id = v_uid and mode = 'pvp' and trust_level = 'verified'
     and created_at > now() - interval '1 day';
  if v_day >= 40 then
    raise exception 'rate limited: daily pvp record quota';
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

-- GC: バッチ ensure + 完全記録は90日 / 欠落は180日で打ち切り
create or replace function public.pvp_gc_stale_rooms()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  -- waiting / abandon も1回25件まで（トリガ ensure の無制限発火防止 — Codex cost cycle-45/46）
  with victims as (
    select id from public.pvp_rooms
     where status = 'waiting'
       and created_at < now() - interval '10 minutes'
     order by created_at asc
     limit 25
     for update skip locked
  )
  update public.pvp_rooms pr
     set status = 'aborted', updated_at = now()
    from victims v
   where pr.id = v.id;

  with victims as (
    select id from public.pvp_rooms
     where status = 'active'
       and updated_at < now() - interval '10 minutes'
       and coalesce(white_last_seen, updated_at) < now() - interval '10 minutes'
       and coalesce(black_last_seen, updated_at) < now() - interval '10 minutes'
     order by updated_at asc
     limit 25
     for update skip locked
  )
  update public.pvp_rooms pr
     set status = 'finished',
         result = '1/2-1/2',
         winner_color = null,
         finish_reason = 'abandon',
         updated_at = now()
    from victims v
   where pr.id = v.id;

  -- 欠落回収は1回最大25件（無制限ループ禁止 — Codex cost cycle-44）
  for r in
    select pr.id from public.pvp_rooms pr
     where pr.status = 'finished'
       and pr.finish_reason is not null
       and coalesce(pr.authority_version, 0) >= 1
       and (
         (pr.white_user_id is not null and not exists (
           select 1 from public.games g
            where g.pvp_room_id = pr.id and g.user_id = pr.white_user_id
         ))
         or
         (pr.black_user_id is not null and not exists (
           select 1 from public.games g
            where g.pvp_room_id = pr.id and g.user_id = pr.black_user_id
         ))
       )
     order by pr.updated_at asc
     limit 25
  loop
    perform public.pvp_ensure_verified_records(r.id);
  end loop;

  delete from public.pvp_rooms
   where status = 'aborted'
     and updated_at < now() - interval '7 days';

  -- 両席揃い: 90 日。欠落 finished は削除しない（GC ensure が quota 緩和で埋める）
  delete from public.pvp_rooms pr
   where pr.status = 'finished'
     and pr.updated_at < now() - interval '90 days'
     and (pr.white_user_id is null or exists (
       select 1 from public.games g
        where g.pvp_room_id = pr.id and g.user_id = pr.white_user_id
     ))
     and (pr.black_user_id is null or exists (
       select 1 from public.games g
        where g.pvp_room_id = pr.id and g.user_id = pr.black_user_id
     ))
     and (pr.white_user_id is not null or pr.black_user_id is not null);
end;
$$;

revoke all on function public.pvp_gc_stale_rooms() from public, anon, authenticated;
grant execute on function public.pvp_gc_stale_rooms() to service_role;

-- ---------------------------------------------------------------------------
-- G003: 9 引数から default を外し、8 引数互換を曖昧さなく追加
-- ---------------------------------------------------------------------------
drop function if exists public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb, text
);

create function public.save_unverified_ai_game(
  p_game_kind text,
  p_you_color text,
  p_outcome text,
  p_result text,
  p_move_count integer,
  p_opponent_label text,
  p_record_text text,
  p_analysis_payload jsonb,
  p_idempotency_key text
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
  else
    if p_result not in ('1-0', '0-1', '1/2-1/2') then
      raise exception 'result/outcome mismatch';
    end if;
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

-- 短時間 dedupe（10分）。games の恒久 idempotency には内容を載せない。
create table if not exists public.legacy_ai_save_dedupe (
  user_id uuid not null references auth.users (id) on delete cascade,
  fingerprint text not null,
  game_id uuid not null references public.games (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, fingerprint)
);

alter table public.legacy_ai_save_dedupe enable row level security;
revoke all on table public.legacy_ai_save_dedupe from public, anon, authenticated;

create index if not exists legacy_ai_save_dedupe_created_at_idx
  on public.legacy_ai_save_dedupe (created_at);

-- 8 引数互換: 10分窓 dedupe + 新規は UUID キー。移行窓専用・後続 DROP 予定。
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
  v_key text;
  v_fp text;
  v_row public.games;
  v_game_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  v_fp := md5(
    v_uid::text || E'\n' ||
    coalesce(p_game_kind, '') || E'\n' ||
    coalesce(p_you_color, '') || E'\n' ||
    coalesce(p_outcome, '') || E'\n' ||
    coalesce(p_result, '') || E'\n' ||
    coalesce(p_move_count::text, '') || E'\n' ||
    coalesce(p_opponent_label, '') || E'\n' ||
    left(coalesce(p_record_text, ''), 4000)
  );

  perform pg_advisory_xact_lock(hashtext('cj:legacy8:' || v_uid::text));

  delete from public.legacy_ai_save_dedupe
   where user_id = v_uid and created_at < now() - interval '1 day';

  select d.game_id into v_game_id
    from public.legacy_ai_save_dedupe d
   where d.user_id = v_uid
     and d.fingerprint = v_fp
     and d.created_at > now() - interval '10 minutes';
  if v_game_id is not null then
    select * into v_row from public.games where id = v_game_id and user_id = v_uid;
    if found then return v_row; end if;
  end if;

  v_key := 'compat8:' || gen_random_uuid()::text;
  v_row := public.save_unverified_ai_game(
    p_game_kind,
    p_you_color,
    p_outcome,
    p_result,
    p_move_count,
    p_opponent_label,
    p_record_text,
    p_analysis_payload,
    v_key
  );

  insert into public.legacy_ai_save_dedupe (user_id, fingerprint, game_id)
  values (v_uid, v_fp, v_row.id)
  on conflict (user_id, fingerprint) do update
    set game_id = excluded.game_id,
        created_at = now();

  return v_row;
end;
$$;

revoke all on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
) to authenticated;

comment on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
) is
  '移行窓: 旧SPA 8引数。10分窓 dedupe 表で再送抑制。games 恒久キーには内容を載せない。'
  '後続 DROP 予定。新クライアントは 9 引数（idempotency_key 必須・default なし）。';
