-- 0013: heartbeat/join の rate_check 順序 + pvp_abort 存在オラクル閉じ
-- Codex cost cycle-26 / authz cycle-26
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

-- ---------------------------------------------------------------------------
-- 1) pvp_heartbeat: 参加者確認 → その後だけ rate_check
-- ---------------------------------------------------------------------------
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

  select * into v_room from public.pvp_rooms where id = p_room_id;
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
  end if;
  if v_room.status is distinct from 'active' then
    return v_room;
  end if;

  -- 参加者確定後のみレート消費（不正 UUID 連打でカウンタを巻き戻させない）
  v_allowed := public.rate_check('pvp:hb:' || v_uid::text, 6, 60);
  if not coalesce(v_allowed, false) then
    raise exception 'rate limited';
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
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
  end if;
  v_room := public.pvp_apply_timeouts(p_room_id);
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

-- ---------------------------------------------------------------------------
-- 2) pvp_join_queue: 日次作成上限を呼び出しレートより前に。rate_check は成功確定直前
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
  v_call_ok boolean;
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
    if coalesce(v_room.authority_version, 0) < 1 then
      update public.pvp_rooms
         set status = 'aborted', updated_at = now()
       where id = v_room.id;
    else
      v_call_ok := public.rate_check('pvp:join:uid:' || v_uid::text, 10, 60);
      if not coalesce(v_call_ok, false) then
        raise exception 'rate limited: too many pvp join calls';
      end if;
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
    v_call_ok := public.rate_check('pvp:join:uid:' || v_uid::text, 10, 60);
    if not coalesce(v_call_ok, false) then
      raise exception 'rate limited: too many pvp join calls';
    end if;
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

  -- 作成上限は呼び出しレートより前（上限到達の raise で join カウンタを巻き戻さない）
  select count(*) into v_day_white
    from public.pvp_rooms
   where white_user_id = v_uid
     and created_at > now() - interval '1 day';
  if v_day_white >= 30 then
    raise exception 'rate limited: daily room create quota';
  end if;

  v_call_ok := public.rate_check('pvp:join:uid:' || v_uid::text, 10, 60);
  if not coalesce(v_call_ok, false) then
    raise exception 'rate limited: too many pvp join calls';
  end if;

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
-- 3) pvp_abort: 不存在と非参加者を同一エラーに
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
  if not found
     or (v_uid is distinct from v_room.white_user_id
         and v_uid is distinct from v_room.black_user_id) then
    raise exception 'room not found';
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

revoke all on function public.pvp_abort(uuid) from public, anon, authenticated;
grant execute on function public.pvp_abort(uuid) to authenticated;

comment on function public.pvp_abort(uuid) is
  'waiting のみ中断。不存在と非参加者は room not found。email 確認必須。';
