// Supabase Edge: Stripe Webhook（entitlement の唯一の書き込み口）
//
// POST /functions/v1/stripe-webhook
//   Stripe-Signature 必須。verify_jwt はダッシュボードで OFF（Stripe は JWT を送らない）。
//
// OWASP A08: 署名検証 + stripe_webhook_events 冪等
// OWASP A09: event type/id のみログ（email / raw body 禁止）

import { isStripeCustomerId, isStripeEventId, isSupabaseUserId } from '../_shared/billingIds.ts';
import type { StripeStatus } from '../_shared/billingPlans.ts';
import { assertStripeSecretKey, verifyStripeWebhook } from '../_shared/stripeHttp.ts';
import {
  fetchProfileBilling,
  fetchProfileByCustomerId,
  patchProfileBilling,
} from '../_shared/stripeProfile.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const EXPECTED_PRICE_ID = (Deno.env.get('STRIPE_PRICE_ID') ?? '').trim();

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 });
  }

  const whsec = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  try {
    assertStripeSecretKey(
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

  const raw = await req.text();
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

  // A08: 先に event_id を確保。重複は 200（Stripe 再送と両立）
  const claimed = await claimWebhookEvent(event.id, event.type);
  if (claimed === 'duplicate') {
    return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
  }
  if (claimed === 'error') {
    return new Response(JSON.stringify({ error: 'idempotency store failed' }), { status: 500 });
  }

  try {
    await handleEvent(event.type, event.data.object);
  } catch (e) {
    console.error('webhook handler error', e instanceof Error ? e.message : 'error');
    // 失敗時は claim を残すと再試行不能 → 削除して 500（Stripe が再送）
    await releaseWebhookEvent(event.id);
    return new Response(JSON.stringify({ error: 'handler failed' }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

async function claimWebhookEvent(
  eventId: string,
  eventType: string,
): Promise<'ok' | 'duplicate' | 'error'> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return 'error';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/stripe_webhook_events`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ event_id: eventId, event_type: eventType.slice(0, 128) }),
    });
    if (res.status === 409) return 'duplicate';
    if (!res.ok) {
      const text = await res.text();
      if (text.includes('duplicate') || text.includes('23505')) return 'duplicate';
      console.error('claim webhook event failed', res.status);
      return 'error';
    }
    return 'ok';
  } catch {
    return 'error';
  }
}

async function releaseWebhookEvent(eventId: string): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/stripe_webhook_events?event_id=eq.${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      },
    );
  } catch {
    /* ignore */
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

async function handleEvent(type: string, obj: Record<string, unknown>): Promise<void> {
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
    if (EXPECTED_PRICE_ID.startsWith('price_')) {
      // line_items は expand しないと無いことがある。metadata / 単一 Price 運用で緩和。
      const lineItems = obj.line_items as
        { data?: { price?: { id?: string } | string }[] } | undefined;
      const first = lineItems?.data?.[0]?.price;
      const priceId = typeof first === 'string' ? first : first?.id;
      if (priceId && priceId !== EXPECTED_PRICE_ID) {
        throw new Error('checkout.session.completed unexpected price');
      }
    }

    const existing = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userIdRaw);
    if (existing?.stripe_customer_id && existing.stripe_customer_id !== customerId) {
      throw new Error('checkout.session.completed customer mismatch');
    }

    await requirePatch(userIdRaw, {
      plan: 'pro',
      stripe_status: 'active',
      stripe_customer_id: customerId,
      stripe_subscription_id: subId,
    });
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

    // 別サブスクの古いイベントで現契約を壊さない
    if (
      profile.stripe_subscription_id &&
      subId &&
      profile.stripe_subscription_id !== subId &&
      (type === 'customer.subscription.deleted' ||
        type === 'invoice.payment_failed' ||
        type === 'customer.subscription.updated')
    ) {
      console.error(`${type}: ignore non-current subscription`);
      return;
    }

    if (type === 'customer.subscription.deleted') {
      await requirePatch(userId, {
        plan: 'free',
        stripe_status: 'canceled',
        stripe_subscription_id: null,
      });
      return;
    }

    if (type === 'invoice.payment_failed') {
      await requirePatch(userId, {
        plan: 'free',
        stripe_status: 'past_due',
      });
      return;
    }

    const status = mapSubStatus(obj.status);
    if (status === 'canceled' || status === 'past_due' || status === 'none') {
      await requirePatch(userId, {
        plan: 'free',
        stripe_status: status === 'none' ? 'past_due' : status,
        ...(status === 'canceled' ? { stripe_subscription_id: null } : {}),
        stripe_customer_id: customerId,
      });
      return;
    }
    // active のみ。かつ「既にこの sub を保持している」場合だけ再確認で Pro 維持。
    // stripe_subscription_id が null（解約直後）のときに古い updated が来ても復活させない。
    // 初回 Pro 付与は checkout.session.completed のみ。
    if (status !== 'active') {
      console.error('subscription.updated ignored: not active paid');
      return;
    }
    if (!subId || profile.stripe_subscription_id !== subId) {
      console.error('subscription.updated ignored: not current stored subscription');
      return;
    }
    await requirePatch(userId, {
      plan: 'pro',
      stripe_status: 'active',
      stripe_subscription_id: subId,
      stripe_customer_id: customerId,
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
