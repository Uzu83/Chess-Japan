-- 0011: attach_unverified_analysis — 一度限り添付 + 書き込み直前レート制限
-- Codex cost cycle-22/24:
--   - analysis_payload IS NULL のみ更新（0008 契約）
--   - 既添付への異 payload 拒否は rate_check より前（失敗経路でカウンタを巻き戻させない）
--   - 新規添付直前のみ uid 12/分
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

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

  select * into v_row
    from public.games
   where id = p_game_id
     and user_id = v_uid
     and trust_level = 'unverified'
     and mode = 'ai';
  if not found then
    raise exception 'game not found';
  end if;

  -- 既添付: 同一なら冪等成功、異内容なら拒否。いずれも rate_check 前（cycle-24）。
  if v_row.analysis_payload is not null then
    if v_row.analysis_payload = p_analysis_payload then
      return v_row;
    end if;
    raise exception 'game not found';
  end if;

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

comment on function public.attach_unverified_analysis(uuid, jsonb) is
  '自己対局への解析後付け（一度限り）。新規添付のみ uid 12/分。';
