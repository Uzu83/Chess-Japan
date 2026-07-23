-- 0019: Tier2 cost/data 振動の解消（owner lock: 180d TTL / ADR 0004）
--   cost: record_retry_after バックオフ（先頭25飢餓防止）。日次40 bypass は置かない。
--   data: 部屋削除の前に archives へ退避。games が参照中なら DELETE せず stub 化（FK 維持）。
--   cost: moves を落とした stub / archives に 730d TTL（無期限禁止）
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

alter table public.pvp_rooms
  add column if not exists record_retry_after timestamptz;

comment on column public.pvp_rooms.record_retry_after is
  '欠落 verified 保存の再試行時刻。クォータ超過時に未来へ進め、GC が同一25件を毎分焼かない。'
  'updated_at は触らない（保持期限を遅延させない）。';

create index if not exists pvp_rooms_ensure_retry_idx
  on public.pvp_rooms (coalesce(record_retry_after, updated_at), updated_at)
  where status = 'finished';

create table if not exists public.pvp_room_archives (
  room_id uuid primary key,
  game_kind text not null,
  white_user_id uuid,
  black_user_id uuid,
  moves jsonb not null default '[]'::jsonb,
  result text,
  winner_color text,
  finish_reason text,
  authority_version integer,
  room_created_at timestamptz,
  room_updated_at timestamptz not null,
  archived_at timestamptz not null default now()
);

alter table public.pvp_room_archives enable row level security;
revoke all on table public.pvp_room_archives from public, anon, authenticated;

comment on table public.pvp_room_archives is
  'finished room の権威スナップショット。service_role のみ。'
  '公開 API からは読めない。必要なら運用者が手動で games へ戻す。';

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
  v_skipped_quota boolean := false;
begin
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
      v_skipped_quota := true;
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

  if v_skipped_quota then
    update public.pvp_rooms
       set record_retry_after = now() + interval '1 hour'
     where id = p_room_id;
  else
    update public.pvp_rooms
       set record_retry_after = null
     where id = p_room_id
       and record_retry_after is not null;
  end if;
end;
$$;

revoke all on function public.pvp_ensure_verified_records(uuid)
  from public, anon, authenticated;
grant execute on function public.pvp_ensure_verified_records(uuid) to service_role;

comment on function public.pvp_ensure_verified_records(uuid) is
  'finished+authority の両者 verified を冪等保存。room→uid advisory。日次40厳守。'
  '超過時は record_retry_after=+1h（クォータ bypass なし）。';

create or replace function public.pvp_archive_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms;
begin
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return; end if;
  -- 旧クライアント権威（version<1）は verified 履歴の種にしない
  if v_room.finish_reason is null or coalesce(v_room.authority_version, 0) < 1 then
    return;
  end if;

  insert into public.pvp_room_archives (
    room_id, game_kind, white_user_id, black_user_id,
    moves, result, winner_color, finish_reason, authority_version,
    room_created_at, room_updated_at, archived_at
  ) values (
    v_room.id, v_room.game_kind, v_room.white_user_id, v_room.black_user_id,
    v_room.moves, v_room.result, v_room.winner_color, v_room.finish_reason,
    v_room.authority_version, v_room.created_at, v_room.updated_at, now()
  )
  on conflict (room_id) do update set
    -- stub（空 moves）で既存の非空アーカイブを潰さない・TTL を延ばさない
    moves = case
      when jsonb_array_length(coalesce(excluded.moves, '[]'::jsonb)) > 0 then excluded.moves
      else public.pvp_room_archives.moves
    end,
    result = coalesce(excluded.result, public.pvp_room_archives.result),
    winner_color = coalesce(excluded.winner_color, public.pvp_room_archives.winner_color),
    finish_reason = coalesce(excluded.finish_reason, public.pvp_room_archives.finish_reason),
    authority_version = coalesce(excluded.authority_version, public.pvp_room_archives.authority_version),
    room_updated_at = excluded.room_updated_at,
    archived_at = case
      when jsonb_array_length(coalesce(excluded.moves, '[]'::jsonb)) > 0 then now()
      else public.pvp_room_archives.archived_at
    end;
end;
$$;

revoke all on function public.pvp_archive_room(uuid)
  from public, anon, authenticated;
grant execute on function public.pvp_archive_room(uuid) to service_role;

-- 退役は常に stub 化のみ（DELETE しない）。FK 用 id を残し、730d materialize を可能にする。
create or replace function public.pvp_retire_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pvp_archive_room(p_room_id);

  update public.pvp_rooms
     set moves = '[]'::jsonb,
         record_retry_after = null,
         updated_at = updated_at
   where id = p_room_id
     and jsonb_array_length(coalesce(moves, '[]'::jsonb)) > 0;
end;
$$;

revoke all on function public.pvp_retire_room(uuid)
  from public, anon, authenticated;
grant execute on function public.pvp_retire_room(uuid) to service_role;

-- archive TTL 直前の最後の games 移送（日次40の対象外・service_role GC のみ）。
-- WHY bypass をここでだけ許すか: 通常 ensure は40厳守。730d で消す前に一度だけ
-- 履歴へ落とさないと data（棋譜喪失）と cost（絶対 TTL）が両立しない。
-- stub 復元 INSERT で空 moves の verified を先に作らない（archive がある INSERT はスキップ）
create or replace function public.pvp_trg_ensure_verified_records()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'finished'
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'finished') then
    if coalesce(jsonb_array_length(NEW.moves), 0) = 0
       and exists (
         select 1 from public.pvp_room_archives a where a.room_id = NEW.id
       ) then
      return NEW;
    end if;
    perform public.pvp_ensure_verified_records(NEW.id);
  end if;
  return NEW;
end;
$$;

-- 戻り値 true = 確認済み席の games が揃い、archive を消してよい
drop function if exists public.pvp_materialize_archive(uuid);
create or replace function public.pvp_materialize_archive(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_arch public.pvp_room_archives;
  v_uid uuid;
  v_uids uuid[];
  v_my_color text;
  v_my_outcome text;
  v_opp uuid;
  v_move_count integer;
  v_record text;
  v_day integer;
  v_ready boolean := true;
begin
  select * into v_arch from public.pvp_room_archives
   where room_id = p_room_id for update;
  if not found then return true; end if;
  if v_arch.finish_reason is null or coalesce(v_arch.authority_version, 0) < 1 then
    return true; -- 不正 archive は削除してよい
  end if;
  if v_arch.result is null or v_arch.result not in ('1-0', '0-1', '1/2-1/2') then
    return false; -- 消さず残す（運用隔離）
  end if;

  if not exists (select 1 from public.pvp_rooms where id = p_room_id) then
    insert into public.pvp_rooms (
      id, game_kind, status, white_user_id, black_user_id,
      moves, result, winner_color, finish_reason, authority_version,
      created_at, updated_at
    ) values (
      v_arch.room_id, v_arch.game_kind, 'finished',
      v_arch.white_user_id, v_arch.black_user_id,
      '[]'::jsonb, coalesce(v_arch.result, '*'), v_arch.winner_color,
      v_arch.finish_reason, coalesce(v_arch.authority_version, 1),
      coalesce(v_arch.room_created_at, now()), coalesce(v_arch.room_updated_at, now())
    );
  end if;

  v_move_count := coalesce(jsonb_array_length(v_arch.moves), 0);
  v_record := public.pvp_sans_to_pgn(v_arch.moves, v_arch.result);

  select array_agg(u order by u)
    into v_uids
    from unnest(array_remove(
      array[v_arch.white_user_id, v_arch.black_user_id],
      null
    )) as u;
  if v_uids is null then return true; end if;

  foreach v_uid in array v_uids
  loop
    if (select email_confirmed_at from auth.users where id = v_uid) is null then
      -- 未確認席は verified 対象外。削除可否は確認済み席だけで判定。
      continue;
    end if;
    if exists (
      select 1 from public.games
       where user_id = v_uid and pvp_room_id = p_room_id
    ) then
      continue;
    end if;

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
      v_ready := false;
      continue;
    end if;

    if v_uid = v_arch.white_user_id then
      v_my_color := 'white';
      v_opp := v_arch.black_user_id;
    else
      v_my_color := 'black';
      v_opp := v_arch.white_user_id;
    end if;

    if v_arch.result = '1/2-1/2' then
      v_my_outcome := 'draw';
    elsif v_arch.result = '1-0' then
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
        v_uid, v_arch.game_kind, 'pvp', 'verified',
        '対人戦', v_opp, v_my_color,
        v_arch.result, v_my_outcome, v_move_count, v_record, false, p_room_id
      );
    exception when unique_violation then
      null;
    end;
  end loop;

  foreach v_uid in array v_uids
  loop
    if (select email_confirmed_at from auth.users where id = v_uid) is null then
      continue;
    end if;
    if not exists (
      select 1 from public.games
       where user_id = v_uid and pvp_room_id = p_room_id
    ) then
      v_ready := false;
    end if;
  end loop;

  return v_ready;
end;
$$;

revoke all on function public.pvp_materialize_archive(uuid)
  from public, anon, authenticated;
grant execute on function public.pvp_materialize_archive(uuid) to service_role;

create or replace function public.pvp_gc_stale_rooms()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
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

  -- stub（moves 空かつ archive 済）以外を再試行。0 手終局のクォータ待ちも拾う。
  for r in
    select pr.id from public.pvp_rooms pr
     where pr.status = 'finished'
       and pr.finish_reason is not null
       and coalesce(pr.authority_version, 0) >= 1
       and (pr.record_retry_after is null or pr.record_retry_after <= now())
       and not (
         jsonb_array_length(coalesce(pr.moves, '[]'::jsonb)) = 0
         and exists (
           select 1 from public.pvp_room_archives a where a.room_id = pr.id
         )
       )
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
     order by coalesce(pr.record_retry_after, pr.updated_at) asc, pr.updated_at asc
     limit 25
  loop
    perform public.pvp_ensure_verified_records(r.id);
  end loop;

  delete from public.pvp_rooms
   where status = 'aborted'
     and updated_at < now() - interval '7 days';

  -- 両席揃い 90 日: サーバー権威のみ archive + stub（0手完備局も含む・未アーカイブ時）
  for r in
    select pr.id from public.pvp_rooms pr
     where pr.status = 'finished'
       and pr.finish_reason is not null
       and coalesce(pr.authority_version, 0) >= 1
       and pr.updated_at < now() - interval '90 days'
       and (
         jsonb_array_length(coalesce(pr.moves, '[]'::jsonb)) > 0
         or not exists (
           select 1 from public.pvp_room_archives a where a.room_id = pr.id
         )
       )
       and (pr.white_user_id is null or exists (
         select 1 from public.games g
          where g.pvp_room_id = pr.id and g.user_id = pr.white_user_id
       ))
       and (pr.black_user_id is null or exists (
         select 1 from public.games g
          where g.pvp_room_id = pr.id and g.user_id = pr.black_user_id
       ))
       and (pr.white_user_id is not null or pr.black_user_id is not null)
     order by pr.updated_at asc
     limit 25
     for update skip locked
  loop
    perform public.pvp_retire_room(r.id);
  end loop;

  -- 欠落 finished 180 日: サーバー権威のみ。stub 再処理しない。
  for r in
    select pr.id from public.pvp_rooms pr
     where pr.status = 'finished'
       and pr.finish_reason is not null
       and coalesce(pr.authority_version, 0) >= 1
       and pr.updated_at < now() - interval '180 days'
       and (
         jsonb_array_length(coalesce(pr.moves, '[]'::jsonb)) > 0
         or not exists (
           select 1 from public.pvp_room_archives a where a.room_id = pr.id
         )
       )
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
     for update skip locked
  loop
    perform public.pvp_retire_room(r.id);
  end loop;

  -- 旧権威 finished は verified 化せず 180d で削除（アーカイブしない）
  delete from public.pvp_rooms
   where status = 'finished'
     and coalesce(authority_version, 0) < 1
     and updated_at < now() - interval '180 days';

  -- stub: archive 消化後かつ games 参照なしなら削除
  delete from public.pvp_rooms pr
   where pr.status = 'finished'
     and pr.updated_at < now() - interval '180 days'
     and jsonb_array_length(coalesce(pr.moves, '[]'::jsonb)) = 0
     and not exists (
       select 1 from public.games g where g.pvp_room_id = pr.id
     )
     and not exists (
       select 1 from public.pvp_room_archives a where a.room_id = pr.id
     );

  -- archives 絶対 730d TTL。削除前に欠落 games を一度だけ materialize（上限25）。
  for r in
    select a.room_id from public.pvp_room_archives a
     where a.archived_at < now() - interval '730 days'
     order by a.archived_at asc
     limit 25
     for update skip locked
  loop
    if public.pvp_materialize_archive(r.room_id) then
      delete from public.pvp_room_archives where room_id = r.room_id;
    end if;
  end loop;

  -- materialize 不能（例: ユーザー消滅）で残った archive の絶対上限: 1095 日
  delete from public.pvp_room_archives
   where archived_at < now() - interval '1095 days';
end;
$$;

revoke all on function public.pvp_gc_stale_rooms() from public, anon, authenticated;
grant execute on function public.pvp_gc_stale_rooms() to service_role;

-- stub 後に空 moves から verified を作らない。archive があれば materialize して返す。
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
  v_arch public.pvp_room_archives;
  v_result text;
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

  -- payload 退役済み: GC bypass 関数は呼ばず、archive から当人行だけを日次40内で復元
  if coalesce(jsonb_array_length(v_room.moves), 0) = 0 then
    select * into v_arch from public.pvp_room_archives where room_id = p_room_id;
    if not found
       or v_arch.finish_reason is null
       or coalesce(v_arch.authority_version, 0) < 1
       or v_arch.result is null
       or v_arch.result not in ('1-0', '0-1', '1/2-1/2') then
      raise exception 'room payload retired';
    end if;
    v_result := v_arch.result;
    v_move_count := coalesce(jsonb_array_length(v_arch.moves), 0);
    v_record := public.pvp_sans_to_pgn(v_arch.moves, v_result);
    if v_result = '1/2-1/2' then
      v_my_outcome := 'draw';
    elsif v_result = '1-0' then
      v_my_outcome := case when v_my_color = 'white' then 'win' else 'loss' end;
    else
      v_my_outcome := case when v_my_color = 'black' then 'win' else 'loss' end;
    end if;
  else
    v_result := v_room.result;
    if v_result not in ('1-0', '0-1', '1/2-1/2') then
      raise exception 'invalid result';
    end if;
    if v_result = '1/2-1/2' then
      v_my_outcome := 'draw';
    elsif v_result = '1-0' then
      v_my_outcome := case when v_my_color = 'white' then 'win' else 'loss' end;
    else
      v_my_outcome := case when v_my_color = 'black' then 'win' else 'loss' end;
    end if;
    v_move_count := coalesce(jsonb_array_length(v_room.moves), 0);
    v_record := public.pvp_sans_to_pgn(v_room.moves, v_result);
  end if;

  insert into public.games (
    user_id, game_kind, mode, trust_level,
    opponent_label, opponent_user_id, you_color,
    result, outcome, move_count, record_text, rated, pvp_room_id
  ) values (
    v_uid, v_room.game_kind, 'pvp', 'verified',
    '対人戦', v_opp, v_my_color,
    v_result, v_my_outcome, v_move_count, v_record, false, p_room_id
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
