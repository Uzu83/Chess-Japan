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
    // 失敗時は claim を残すと再試行不能になるため削除して 500（Stripe が再送）
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
    if (res.status === 409 || res.status === 23505) return 'duplicate';
    // PostgREST unique violation → 409
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

async function handleEvent(type: string, obj: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;

  if (type === 'checkout.session.completed') {
    const userIdRaw =
      (typeof obj.client_reference_id === 'string' && obj.client_reference_id) ||
      metaUserId(obj.metadata);
    const customerId = typeof obj.customer === 'string' ? obj.customer : null;
    const subId = typeof obj.subscription === 'string' ? obj.subscription : null;
    if (!userIdRaw || !isSupabaseUserId(userIdRaw)) {
      console.error('checkout.session.completed missing/invalid user id');
      return;
    }
    if (customerId && !isStripeCustomerId(customerId)) {
      console.error('checkout.session.completed invalid customer id');
      return;
    }

    // A01: 既存 customer と不一致なら拒否（他人への entitlement 付け替え防止）
    const existing = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userIdRaw);
    if (existing?.stripe_customer_id && customerId && existing.stripe_customer_id !== customerId) {
      console.error('checkout.session.completed customer mismatch');
      return;
    }

    await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userIdRaw, {
      plan: 'pro',
      stripe_status: 'active',
      ...(customerId ? { stripe_customer_id: customerId } : {}),
      ...(subId ? { stripe_subscription_id: subId } : {}),
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

    let userId = metaUserId(obj.metadata);
    if (userId && !isSupabaseUserId(userId)) userId = null;

    const profile =
      (userId ? await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userId) : null) ??
      (customerId
        ? await fetchProfileByCustomerId(SUPABASE_URL, SERVICE_ROLE_KEY, customerId)
        : null);
    if (!profile) {
      console.error(`${type}: profile not found`);
      return;
    }
    userId = profile.id;

    if (type === 'customer.subscription.deleted') {
      await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userId, {
        plan: 'free',
        stripe_status: 'canceled',
        stripe_subscription_id: null,
      });
      return;
    }

    if (type === 'invoice.payment_failed') {
      await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userId, {
        stripe_status: 'past_due',
      });
      return;
    }

    const status = mapSubStatus(obj.status);
    const subId = typeof obj.id === 'string' ? obj.id : profile.stripe_subscription_id;
    if (status === 'canceled') {
      await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userId, {
        plan: 'free',
        stripe_status: 'canceled',
        stripe_subscription_id: null,
      });
      return;
    }
    await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, userId, {
      plan: status === 'active' ? 'pro' : 'free',
      stripe_status: status,
      ...(subId ? { stripe_subscription_id: subId } : {}),
      ...(customerId ? { stripe_customer_id: customerId } : {}),
    });
  }
}

function metaUserId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  return typeof m.supabase_user_id === 'string' ? m.supabase_user_id : null;
}

function mapSubStatus(raw: unknown): StripeStatus {
  if (raw === 'active' || raw === 'trialing') return 'active';
  if (raw === 'past_due' || raw === 'unpaid') return 'past_due';
  if (raw === 'canceled' || raw === 'incomplete_expired') return 'canceled';
  return 'none';
}
