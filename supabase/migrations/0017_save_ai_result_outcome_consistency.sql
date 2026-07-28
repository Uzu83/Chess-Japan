-- 0017: save_unverified_ai_game の result/outcome 整合（チェス終了局）
-- Codex cost cycle-39: win+`*` 等の矛盾履歴を拒否
-- explain_cache / rate_counters RLS・GRANT、apply_rated_result GRANT には触れない。

create or replace function public.save_unverified_ai_game(
  p_game_kind text,
  p_you_color text,
  p_outcome text,
  p_result text,
  p_move_count integer,
  p_opponent_label text,
  p_record_text text,
  p_analysis_payload jsonb default null,
  p_idempotency_key text default null
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
    -- 終了局は絶対結果が必須（チェス）。将棋も同じ記号を使う。
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
