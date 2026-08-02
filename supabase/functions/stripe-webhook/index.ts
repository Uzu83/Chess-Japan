// Supabase Edge: Stripe Webhook（entitlement の唯一の書き込み口）
//
// POST /functions/v1/stripe-webhook
//   Stripe-Signature 必須。verify_jwt はダッシュボードで OFF（Stripe は JWT を送らない）。
//
// OWASP A08: 署名検証 + stripe_webhook_events 冪等（processing lease）
// OWASP A09: event type/id のみログ（email / raw body 禁止）
//
// reconcile: entitlement はイベント snapshot ではなく Stripe API の現在 Subscription を正とする。
//   → 遅延/逆順イベントで stale active が解約後に Pro を復活させない。
//   → checkout.session.completed 欠落時も subscription.updated(active) で自己修復できる。

import { isStripeCustomerId, isStripeEventId, isSupabaseUserId } from '../_shared/billingIds.ts';
import type { StripeStatus } from '../_shared/billingPlans.ts';
import { readBodyCapped } from '../_shared/readBodyCapped.ts';
import {
  assertStripeSecretKey,
  fetchSubscriptionSnapshot,
  requirePriceId,
  verifyStripeWebhook,
} from '../_shared/stripeHttp.ts';
import {
  fetchProfileBilling,
  fetchProfileByCustomerId,
  patchProfileBilling,
} from '../_shared/stripeProfile.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// fail-closed: Price 未設定時に検証をスキップすると別 SKU でも Pro 付与されうる（監査 medium）。
let EXPECTED_PRICE_ID = '';
try {
  EXPECTED_PRICE_ID = requirePriceId(Deno.env.get('STRIPE_PRICE_ID') ?? undefined);
} catch {
  // Deno.serve 内で 503 を返す（モジュール load 時 throw は起動失敗ログが分かりにくい）
}
const MAX_WEBHOOK_BYTES = 256_000;
/** processing のまま放置された claim を再取得可能にする lease（秒）。 */
const CLAIM_LEASE_SEC = Number(Deno.env.get('STRIPE_WEBHOOK_CLAIM_LEASE_SEC') ?? '300');

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 });
  }
  if (!EXPECTED_PRICE_ID.startsWith('price_')) {
    return new Response(JSON.stringify({ error: 'billing not configured' }), { status: 503 });
  }

  const whsec = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  let stripeSecret: string;
  try {
    stripeSecret = assertStripeSecretKey(
      Deno.env.get('STRIPE_SECRET_KEY') ?? undefined,
      Deno.env.get('STRIPE_ALLOW_LIVE') === '1',
    );
  } catch (e) {
    console.error('stripe config', e instanceof Error ? e.name : 'error');
    return new Response(JSON.stringify({ error: 'billing not configured' }), { status: 503 });
  }
  if (!whsec.startsWith('whsec_')) {
    return new Response(JSON.stringify({ error: 'webhook secret missing' }), { status: 503 });
  }

  // OWASP A04: 署名前に body 上限（未認証 DoS 対策）
  const raw = await readBodyCapped(req, MAX_WEBHOOK_BYTES);
  if (raw === null) {
    return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413 });
  }
  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = await verifyStripeWebhook(raw, req.headers.get('stripe-signature'), whsec);
  } catch (e) {
    console.error('webhook verify failed', e instanceof Error ? e.message : 'error');
    return new Response(JSON.stringify({ error: 'invalid signature' }), { status: 400 });
  }

  if (!isStripeEventId(event.id)) {
    return new Response(JSON.stringify({ error: 'invalid event id' }), { status: 400 });
  }

  console.log(`stripe event type=${event.type} id=${event.id}`);

  const claimed = await claimWebhookEvent(event.id, event.type);
  if (claimed === 'duplicate') {
    return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
  }
  if (claimed === 'error') {
    return new Response(JSON.stringify({ error: 'idempotency store failed' }), { status: 500 });
  }

  try {
    await handleEvent(event.type, event.data.object, stripeSecret);
  } catch (e) {
    console.error('webhook handler error', e instanceof Error ? e.message : 'error');
    await markWebhookEvent(event.id, 'failed');
    return new Response(JSON.stringify({ error: 'handler failed' }), { status: 500 });
  }

  await markWebhookEvent(event.id, 'completed');
  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

async function claimWebhookEvent(
  eventId: string,
  eventType: string,
): Promise<'ok' | 'duplicate' | 'error'> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return 'error';
  const nowIso = new Date().toISOString();
  try {
    // 1) 新規 insert（processing）
    const res = await fetch(`${SUPABASE_URL}/rest/v1/stripe_webhook_events`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event_id: eventId,
        event_type: eventType.slice(0, 128),
        status: 'processing',
        processing_started_at: nowIso,
      }),
    });
    if (res.ok) return 'ok';
    const text = await res.text();
    const isDup = res.status === 409 || text.includes('duplicate') || text.includes('23505');
    if (!isDup) {
      console.error('claim webhook event failed', res.status);
      return 'error';
    }

    // 2) 既存行: completed → duplicate / failed|lease切れ processing → 再取得
    const get = await fetch(
      `${SUPABASE_URL}/rest/v1/stripe_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=status,processing_started_at`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!get.ok) return 'error';
    const rows = (await get.json()) as { status?: string; processing_started_at?: string }[];
    const row = rows[0];
    if (!row) return 'error';
    if (row.status === 'completed') return 'duplicate';

    const startedMs = row.processing_started_at ? Date.parse(row.processing_started_at) : NaN;
    const leaseAlive =
      row.status === 'processing' &&
      Number.isFinite(startedMs) &&
      Date.now() - startedMs < CLAIM_LEASE_SEC * 1000;
    if (leaseAlive) return 'duplicate'; // 別 worker が処理中

    // failed または lease 切れ → processing に戻して再処理
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/stripe_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&status=neq.completed`,
      {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          status: 'processing',
          processing_started_at: nowIso,
          event_type: eventType.slice(0, 128),
        }),
      },
    );
    if (!patch.ok) return 'error';
    const patched = (await patch.json()) as unknown[];
    if (!Array.isArray(patched) || patched.length === 0) return 'duplicate';
    return 'ok';
  } catch {
    return 'error';
  }
}

async function markWebhookEvent(eventId: string, status: 'completed' | 'failed'): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/stripe_webhook_events?event_id=eq.${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status }),
      },
    );
  } catch {
    /* ignore — Stripe 再送 / lease でリカバリ */
  }
}

async function requirePatch(
  userId: string,
  patch: Parameters<typeof patchProfileBilling>[3],
): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('store unavailable');
  const ok = await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userId, patch);
  if (!ok) throw new Error(`profile patch failed for ${userId.slice(0, 8)}`);
}

/**
 * Stripe API の現在 Subscription を正として profiles を更新する。
 * - active + 期待 Price → Pro
 * - それ以外（canceled/past_due/別 Price）→ free + 対応 status
 */
async function reconcileSubscription(
  stripeSecret: string,
  userId: string,
  customerId: string,
  subscriptionId: string,
  opts?: { allowBootstrap?: boolean; storedSubId?: string | null },
): Promise<void> {
  const snap = await fetchSubscriptionSnapshot(stripeSecret, subscriptionId);
  if (!snap) throw new Error('subscription fetch failed');
  if (snap.customerId && snap.customerId !== customerId) {
    throw new Error('subscription customer mismatch');
  }

  const status = mapSubStatus(snap.status);
  const priceOk = snap.priceId === EXPECTED_PRICE_ID;

  // 別 sub を保持しているのに、イベントの sub が違う場合は触らない
  // （ただし stored が null で bootstrap 許可なら付与可）
  const stored = opts?.storedSubId;
  if (stored && stored !== subscriptionId) {
    console.error('reconcile: ignore non-current subscription');
    return;
  }
  if (!stored && !opts?.allowBootstrap && status === 'active') {
    // 旧挙動互換の安全側: stored 無しの active は checkout 経路か明示 bootstrap のみ
    console.error('reconcile: active without stored sub and bootstrap disabled');
    return;
  }

  if (status === 'active' && priceOk) {
    await requirePatch(userId, {
      plan: 'pro',
      stripe_status: 'active',
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
    });
    return;
  }

  if (!priceOk && status === 'active') {
    console.error('reconcile: unexpected price; demoting');
  }

  let demoteStatus: StripeStatus;
  if (!priceOk) demoteStatus = 'canceled';
  else if (status === 'canceled' || status === 'past_due') demoteStatus = status;
  else demoteStatus = 'past_due';

  await requirePatch(userId, {
    plan: 'free',
    stripe_status: demoteStatus,
    stripe_customer_id: customerId,
    ...(demoteStatus === 'canceled' || !priceOk ? { stripe_subscription_id: null } : {}),
  });
}

async function handleEvent(
  type: string,
  obj: Record<string, unknown>,
  stripeSecret: string,
): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('store unavailable');

  if (type === 'checkout.session.completed') {
    // 未払い・非 subscription では entitlement を上げない（コスト防衛）。
    if (obj.mode !== 'subscription') {
      console.error('checkout.session.completed ignored: mode!=subscription');
      return;
    }
    // Week-1: trial / 0円は Pro を付けない（LLM 原価防衛）。paid のみ。
    if (obj.payment_status !== 'paid') {
      console.error('checkout.session.completed ignored: unpaid');
      return;
    }
    const userIdRaw =
      (typeof obj.client_reference_id === 'string' && obj.client_reference_id) ||
      metaUserId(obj.metadata);
    const customerId = typeof obj.customer === 'string' ? obj.customer : null;
    const subId = typeof obj.subscription === 'string' ? obj.subscription : null;
    if (!userIdRaw || !isSupabaseUserId(userIdRaw)) {
      throw new Error('checkout.session.completed missing/invalid user id');
    }
    if (!customerId || !isStripeCustomerId(customerId)) {
      throw new Error('checkout.session.completed missing/invalid customer');
    }
    if (!subId || typeof subId !== 'string') {
      throw new Error('checkout.session.completed missing subscription');
    }

    const existing = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userIdRaw);
    if (existing?.stripe_customer_id && existing.stripe_customer_id !== customerId) {
      throw new Error('checkout.session.completed customer mismatch');
    }

    // API 現在状態で付与（遅延イベントで既に解約済みなら Pro にしない）
    await reconcileSubscription(stripeSecret, userIdRaw, customerId, subId, {
      allowBootstrap: true,
      storedSubId: existing?.stripe_subscription_id ?? null,
    });
    // stored が別 sub のとき reconcile が no-op になりうる → 別契約中は触らないのが正しい
    return;
  }

  if (
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted' ||
    type === 'invoice.payment_failed'
  ) {
    const customerId =
      typeof obj.customer === 'string' && isStripeCustomerId(obj.customer) ? obj.customer : null;
    if (!customerId) {
      throw new Error(`${type}: missing/invalid customer`);
    }

    // A01: customer を正とする。metadata uid がある場合は同一 profile であることを要求。
    const byCustomer = await fetchProfileByCustomerId(SUPABASE_URL, SERVICE_ROLE_KEY, customerId);
    const metaUid = metaUserId(obj.metadata);
    const metaOk = metaUid && isSupabaseUserId(metaUid) ? metaUid : null;
    if (metaOk) {
      const byMeta = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, metaOk);
      if (byMeta && byCustomer && byMeta.id !== byCustomer.id) {
        throw new Error(`${type}: metadata/customer profile mismatch`);
      }
      if (byMeta?.stripe_customer_id && byMeta.stripe_customer_id !== customerId) {
        throw new Error(`${type}: metadata profile customer mismatch`);
      }
    }

    const profile =
      byCustomer ??
      (metaOk ? await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, metaOk) : null);
    if (!profile) {
      // 未知 customer は再試行しても増えない → ログして ack（throw しない）
      console.error(`${type}: profile not found`);
      return;
    }
    const userId = profile.id;
    // subscription.* → obj.id が sub_…。invoice.* → obj.subscription が sub_…（obj.id は in_…）。
    const subId =
      type === 'invoice.payment_failed'
        ? typeof obj.subscription === 'string'
          ? obj.subscription
          : null
        : typeof obj.id === 'string'
          ? obj.id
          : null;

    if (!subId || !subId.startsWith('sub_')) {
      throw new Error(`${type}: missing subscription id`);
    }

    // invoice.payment_failed: 現契約と一致しない invoice では降格しない
    if (
      type === 'invoice.payment_failed' &&
      profile.stripe_subscription_id &&
      profile.stripe_subscription_id !== subId
    ) {
      console.error(`${type}: ignore non-current subscription`);
      return;
    }

    // deleted / updated / payment_failed いずれも API 現在状態で reconcile。
    // stored が null でも active+期待 Price なら bootstrap（checkout 欠落の自己修復）。
    // stored が別 sub なら ignore（上の reconcile 内）。
    await reconcileSubscription(stripeSecret, userId, customerId, subId, {
      allowBootstrap: true,
      storedSubId: profile.stripe_subscription_id,
    });
  }
}

function metaUserId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  return typeof m.supabase_user_id === 'string' ? m.supabase_user_id : null;
}

function mapSubStatus(raw: unknown): StripeStatus {
  // trialing は active にしない（Week-1・原価防衛）
  if (raw === 'active') return 'active';
  if (raw === 'past_due' || raw === 'unpaid') return 'past_due';
  if (raw === 'canceled' || raw === 'incomplete_expired') return 'canceled';
  return 'none';
}
