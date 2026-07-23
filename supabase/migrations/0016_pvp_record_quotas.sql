-- 0016: pvp_record_game に日次保存上限 + verified PvP 保持上限
-- Codex / GPT score loop2 G002（defer→実装）
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

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

  -- unverified AI trim（0015）
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

  -- verified PvP 保持上限 300（最古から）
  select count(*) into v_n from public.games
   where user_id = v_uid and mode = 'pvp' and trust_level = 'verified';
  if v_n > 300 then
    delete from public.games
     where id in (
       select id from public.games
        where user_id = v_uid and mode = 'pvp' and trust_level = 'verified'
        order by created_at asc
        limit (v_n - 300)
     );
  end if;

  return v_room;
end;
$$;

revoke all on function public.pvp_record_game(uuid) from public, anon, authenticated;
grant execute on function public.pvp_record_game(uuid) to authenticated;

comment on function public.pvp_record_game(uuid) is
  'finished room の本人 verified 保存。日次40・保持300。result/record はサーバー生成。';
