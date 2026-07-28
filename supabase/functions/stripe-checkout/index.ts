// Supabase Edge: Stripe Checkout Session 作成（Week-1）
//
// POST /functions/v1/stripe-checkout
//   Authorization: Bearer <user JWT>（必須・email confirmed）
//   → { url } へリダイレクト用
//
// OWASP: docs/security/OWASP-billing.md
// 秘密: STRIPE_SECRET_KEY / STRIPE_PRICE_ID / SITE_URL（return URL・Origin 不使用）

import { getAuthUser } from '../_shared/authUser.ts';
import { resolveBillingSiteUrl } from '../_shared/billingSite.ts';
import { rateCheck } from '../_shared/rateCheck.ts';
import { assertStripeSecretKey, requirePriceId, stripeRequest } from '../_shared/stripeHttp.ts';
import { fetchProfileBilling, patchProfileBilling } from '../_shared/stripeProfile.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SB_PUBLISHABLE_KEY');
// 本番 Edge のみ。ローカル `functions serve` は localhost return を許可する。
const IS_HOSTED = Boolean(Deno.env.get('SB_EXECUTION_ID'));

const BILLING_RATE_PER_MIN = Number(Deno.env.get('BILLING_RATE_PER_MIN') ?? '5');
const BILLING_RATE_PER_DAY = Number(Deno.env.get('BILLING_RATE_PER_DAY') ?? '20');

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function cors(origin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  if (ALLOWED_ORIGINS.includes('*')) {
    return { ...base, 'Access-Control-Allow-Origin': origin ?? '*' };
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin };
  }
  if (ALLOWED_ORIGINS.length === 0) {
    return { ...base, 'Access-Control-Allow-Origin': origin ?? '*' };
  }
  return { ...base, 'Access-Control-Allow-Origin': 'null' };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503, headers });
  }

  let secret: string;
  let priceId: string;
  try {
    secret = assertStripeSecretKey(
      Deno.env.get('STRIPE_SECRET_KEY') ?? undefined,
      Deno.env.get('STRIPE_ALLOW_LIVE') === '1',
    );
    priceId = requirePriceId(Deno.env.get('STRIPE_PRICE_ID') ?? undefined);
  } catch (e) {
    console.error('stripe config', e instanceof Error ? e.name : 'error');
    return new Response(JSON.stringify({ error: 'billing not configured' }), {
      status: 503,
      headers,
    });
  }

  // A01: return URL は env のみ（リクエスト Origin は使わない）
  const site = resolveBillingSiteUrl({
    siteUrlEnv: Deno.env.get('SITE_URL') ?? undefined,
    allowedOriginsEnv: Deno.env.get('ALLOWED_ORIGINS') ?? undefined,
    isHosted: IS_HOSTED,
  });
  if (!site) {
    return new Response(JSON.stringify({ error: 'SITE_URL not configured' }), {
      status: 503,
      headers,
    });
  }

  const user = await getAuthUser(req, {
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
  });
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });
  }
  if (!user.emailConfirmed) {
    return new Response(JSON.stringify({ error: 'email not confirmed' }), { status: 403, headers });
  }

  // A04: Checkout 濫用（セッション洪水）防止
  const min = await rateCheck(
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    `bill:co:min:${user.id}`,
    BILLING_RATE_PER_MIN,
    60,
  );
  if (!min.allow) {
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
  }
  const day = await rateCheck(
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    `bill:co:day:${user.id}`,
    BILLING_RATE_PER_DAY,
    86_400,
  );
  if (!day.allow) {
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
  }

  const profile = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, user.id);
  if (!profile) {
    return new Response(JSON.stringify({ error: 'profile missing' }), { status: 400, headers });
  }
  if (profile.plan === 'pro' && profile.stripe_status === 'active') {
    return new Response(JSON.stringify({ error: 'already subscribed' }), { status: 409, headers });
  }

  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const customer = await stripeRequest<{ id: string }>(
      secret,
      'POST',
      '/customers',
      {
        email: user.email ?? undefined,
        'metadata[supabase_user_id]': user.id,
      },
      { idempotencyKey: `cj-cust-${user.id}` },
    );
    customerId = customer.id;
    await patchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, user.id, {
      stripe_customer_id: customerId,
    });
  }

  const session = await stripeRequest<{ url?: string; id: string }>(
    secret,
    'POST',
    '/checkout/sessions',
    {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': 1,
      success_url: `${site}/?billing=success`,
      cancel_url: `${site}/?billing=cancel`,
      'subscription_data[metadata][supabase_user_id]': user.id,
      'metadata[supabase_user_id]': user.id,
      locale: 'ja',
      allow_promotion_codes: 'false',
    },
  );

  if (!session.url) {
    return new Response(JSON.stringify({ error: 'checkout session missing url' }), {
      status: 502,
      headers,
    });
  }

  console.log(`checkout session created user=${user.id.slice(0, 8)}`);
  return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });
});
