-- 0020_profiles_stripe_plan.sql
-- Stripe Pro（Week-1）: profiles に plan / Stripe ID を追加。
--
-- 【不変】
--   - explain_cache / rate_counters の RLS・GRANT には触れない
--   - plan / stripe_* は client UPDATE GRANT を足さない（display_name のみ従来どおり）
--   - 書き込みは Edge webhook（service_role）のみ
--
-- 【WHY plan を profiles に載せるか】
--   explain が JWT → profiles.plan → モデル/枠を解決する。別テーブルは JOIN が増え、
--   Week-1 の単一 SKU には過剰。

alter table public.profiles
  add column if not exists plan text not null default 'free'
    check (plan in ('free', 'pro'));

alter table public.profiles
  add column if not exists stripe_customer_id text
    check (stripe_customer_id is null or char_length(stripe_customer_id) <= 255);

alter table public.profiles
  add column if not exists stripe_subscription_id text
    check (stripe_subscription_id is null or char_length(stripe_subscription_id) <= 255);

-- past_due は課金失敗中。explain では pro 扱いを外し free 枠に落とす（コスト防衛）。
alter table public.profiles
  add column if not exists stripe_status text not null default 'none'
    check (stripe_status in ('none', 'active', 'past_due', 'canceled'));

comment on column public.profiles.plan is
  'Billing tier: free|pro. Written only by Stripe webhook (service_role).';
comment on column public.profiles.stripe_customer_id is
  'Stripe Customer id (cus_...). Null until first checkout.';
comment on column public.profiles.stripe_subscription_id is
  'Stripe Subscription id (sub_...). Cleared on cancel.';
comment on column public.profiles.stripe_status is
  'Mirror of subscription lifecycle for server-side entitlement checks.';

-- 検索用（webhook で customer id → uid 解決）
create unique index if not exists profiles_stripe_customer_id_uidx
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

-- 【意図的に GRANT UPDATE を追加しない】
-- 0004/0006 と同じ: クライアントが直接書けるのは display_name のみ。
