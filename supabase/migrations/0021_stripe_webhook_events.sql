-- 0021_stripe_webhook_events.sql
-- Stripe webhook 冪等テーブル（OWASP A08: 再送・改ざんイベントの二重適用防止）
--
-- 【不変】explain_cache / rate_counters と同様:
--   RLS ON・ポリシー無し・anon/authenticated GRANT 無し。入口は service_role のみ。

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  constraint stripe_webhook_events_event_id_len check (char_length(event_id) <= 255),
  constraint stripe_webhook_events_type_len check (char_length(event_type) <= 128)
);

comment on table public.stripe_webhook_events is
  'Processed Stripe event ids for webhook idempotency. service_role only.';

alter table public.stripe_webhook_events enable row level security;

revoke all on table public.stripe_webhook_events from anon, authenticated;
grant all on table public.stripe_webhook_events to service_role;
