-- 0018: 採点ループ Top3（G002 / G003）
--   G002: finished 遷移時に両者 verified を冪等保存。未記録 finished は GC しない。
--   G003: 旧 SPA 向け 8 引数 save_unverified_ai_game 互換オーバーロード。
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

-- ---------------------------------------------------------------------------
-- G002: 終局 room → 両者 games 行を冪等作成（クライアント不在でも履歴が残る）
-- ---------------------------------------------------------------------------
create or replace function public.pvp_ensure_verified_records(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms;
  v_uid uuid;
  v_my_color text;
  v_my_outcome text;
  v_opp uuid;
  v_move_count integer;
  v_record text;
  v_day integer;
begin
  -- 呼び出し元が既に行ロックしていることがあるため FOR UPDATE はしない
  select * into v_room from public.pvp_rooms where id = p_room_id;
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

  foreach v_uid in array array_remove(
    array[v_room.white_user_id, v_room.black_user_id],
    null
  )
  loop
    -- 参加時点で確認済みのはずだが、未確認は飛ばす（verified 汚染防止）
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

    -- ロック後に再確認（並行 pvp_record_game とのレース）
    if exists (
      select 1 from public.games
       where user_id = v_uid and pvp_room_id = p_room_id
    ) then
      continue;
    end if;

    -- 日次40はクライアント経路と同額。超過時は未保存のまま残し、後続 GC ensure で再試行
    -- （無制限 INSERT でコスト防衛を迂回しない — Codex cost cycle-42）
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
  'finished+authority の両者 verified を冪等保存。終局トリガ / GC から呼ぶ。'
  '日次40超過時はスキップ（room は未記録のまま保持し後続 ensure で再試行）。';

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

-- GC: 未記録 finished を消さない。削除前に ensure を一度試す。
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
  -- 上記 update はトリガで ensure される

  -- 参加者ごとの行が欠けている finished を回収（片側だけ保存済みも含む）
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
  loop
    perform public.pvp_ensure_verified_records(r.id);
  end loop;

  delete from public.pvp_rooms
   where status = 'aborted'
     and updated_at < now() - interval '7 days';

  -- 両参加者分が揃った finished のみ 90 日後削除（片側欠落は残す — Codex data cycle-42）
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
-- G003: 旧 8 引数オーバーロード（idempotency をサーバー生成して 9 引数へ委譲）
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
  v_key text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  -- 旧SPAは冪等キーを持たない。内容ハッシュは別対局を潰し得るため使わない
  -- （Codex data cycle-42）。呼び出しごとに新規キー＝旧挙動に近い再送は重複し得る。
  v_key := 'compat8:' || gen_random_uuid()::text;
  return public.save_unverified_ai_game(
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
  '移行窓: 旧SPA 8引数互換。キーは呼び出しごと UUID（内容ハッシュは使わない）。'
  '新クライアントは 9 引数を使うこと。';
