-- 0012: pvp_join_queue に uid 単位の呼び出しレート（作成件数とは別）
-- Codex cost cycle-23: 既存 waiting/active があるとき無制限に RPC 連打できる穴を閉じる。
-- 0010 の GC-after-success / fail-closed cutover 契約は維持。

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

  -- 呼び出し自体 10/分（ルーム作成件数の 5/分とは独立）。成功リターンでコミットされる。
  v_call_ok := public.rate_check('pvp:join:uid:' || v_uid::text, 10, 60);
  if not coalesce(v_call_ok, false) then
    raise exception 'rate limited: too many pvp join calls';
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

comment on function public.pvp_join_queue(text) is
  'マッチング。uid 呼び出し 10/分 + 作成 5/分 + 日次 waiting 30。GC は成功後のみ。';
