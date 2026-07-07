-- 原子的レート制限/クォータ。固定窓(fixed window)を bucket_key に encode し、
-- 1 ステートメントの upsert+increment で競合なくカウントする。
-- SECURITY DEFINER: 関数所有者(postgres)権限で実行し RLS をバイパスして rate_counters を更新する。
--   ただし実行権限は service_role のみに絞る(下の revoke/grant)。anon/authenticated からは呼べない。
-- 返り値: true=許可(上限内) / false=超過。
create or replace function public.rate_check(
  p_key text,               -- 識別子(例 "min:ip:1.2.3.4" / "day:ip:1.2.3.4")
  p_limit integer,          -- このウィンドウの上限回数
  p_window_seconds integer  -- ウィンドウ長(秒)。分=60, 日=86400 等
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text;
  v_count integer;
begin
  -- ウィンドウ開始を window 単位に丸めて固定窓バケットを作る。
  v_bucket := p_key || ':' || (floor(extract(epoch from clock_timestamp()) / p_window_seconds))::bigint;
  insert into public.rate_counters (bucket_key, count, expires_at)
    values (v_bucket, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (bucket_key) do update
    set count = public.rate_counters.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

-- 実行権限を service_role だけに限定(コスト防衛の要: 公開ロールから直接呼ばせない)。
revoke all on function public.rate_check(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_check(text, integer, integer) to service_role;

-- 期限切れカウンタの掃除(任意呼び出し用)。同じく service_role 限定。
create or replace function public.rate_gc() returns void
language sql security definer set search_path = public as $$
  delete from public.rate_counters where expires_at < now();
$$;
revoke all on function public.rate_gc() from public, anon, authenticated;
grant execute on function public.rate_gc() to service_role;
