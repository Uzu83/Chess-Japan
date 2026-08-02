-- 0022_stripe_webhook_event_status.sql
-- Webhook 冪等の「先行 claim → handler 失敗で永久欠落」を防ぐ。
--
-- 旧 0021 は event_id INSERT のみ。handler 失敗時に DELETE できなければ Stripe 再送が
-- duplicate 200 になり、entitlement が永遠に更新されない（監査 H1）。
--
-- status:
--   processing … 処理中（lease 付き。期限切れなら再取得可）
--   completed  … 成功（再送は duplicate）
--   failed     … 失敗（再送で再処理可）
--
-- 【不変】RLS ON・ポリシー無し・anon/authenticated GRANT 無し（0021 継承）。

-- default completed: 旧 Edge（status を送らない）が migration 直後も成功行を
-- completed 扱いにできるようにする。新 Edge は INSERT 時に processing を明示する。
alter table public.stripe_webhook_events
  add column if not exists status text not null default 'completed'
    check (status in ('processing', 'completed', 'failed')),
  add column if not exists processing_started_at timestamptz not null default now();

comment on column public.stripe_webhook_events.status is
  'processing|completed|failed — lease retry for stuck processing / failed';

-- 0021 時代の行は成功 ack 済みのみ残存（失敗時は DELETE していた）→ completed 確定。
update public.stripe_webhook_events
set status = 'completed'
where status is distinct from 'completed';
