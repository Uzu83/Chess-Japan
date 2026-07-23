-- 0011: attach_unverified_analysis にユーザー単位レート制限
-- Codex cost cycle-22: 64KB payload の無制限再書き込みを防ぐ。
-- explain_cache / rate_counters の RLS・GRANT、apply_rated_result GRANT には触れない。

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
  v_allowed boolean;
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

  -- 12/分。失敗時は fail-closed（rate_check が false / 例外相当扱い）。
  v_allowed := public.rate_check('attach:uid:' || v_uid::text, 12, 60);
  if not coalesce(v_allowed, false) then
    raise exception 'rate limited';
  end if;

  update public.games
     set analysis_payload = p_analysis_payload
   where id = p_game_id
     and user_id = v_uid
     and trust_level = 'unverified'
     and mode = 'ai'
  returning * into v_row;

  if not found then
    raise exception 'game not found';
  end if;
  return v_row;
end;
$$;

revoke all on function public.attach_unverified_analysis(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.attach_unverified_analysis(uuid, jsonb) to authenticated;

comment on function public.attach_unverified_analysis(uuid, jsonb) is
  '自己対局への解析後付け。uid 単位 12/分。trust_level=unverified・mode=ai のみ。';
