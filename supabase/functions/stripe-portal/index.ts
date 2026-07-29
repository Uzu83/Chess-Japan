// Supabase Edge: Stripe Customer Portal（解約・カード更新）
//
// POST /functions/v1/stripe-portal
//   Authorization: Bearer <user JWT>
//   → { url }
//
// OWASP: docs/security/OWASP-billing.md

import { getAuthUser } from '../_shared/authUser.ts';
import { resolveBillingSiteUrl } from '../_shared/billingSite.ts';
import { rateCheck } from '../_shared/rateCheck.ts';
import { assertStripeSecretKey, stripeRequest } from '../_shared/stripeHttp.ts';
import { fetchProfileBilling } from '../_shared/stripeProfile.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SB_PUBLISHABLE_KEY');
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
  try {
    secret = assertStripeSecretKey(
      Deno.env.get('STRIPE_SECRET_KEY') ?? undefined,
      Deno.env.get('STRIPE_ALLOW_LIVE') === '1',
    );
  } catch (e) {
    console.error('stripe config', e instanceof Error ? e.name : 'error');
    return new Response(JSON.stringify({ error: 'billing not configured' }), {
      status: 503,
      headers,
    });
  }

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

  const min = await rateCheck(
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    `bill:po:min:${user.id}`,
    BILLING_RATE_PER_MIN,
    60,
  );
  if (min === 'limited') {
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
  }
  if (min === 'error') {
    return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
      status: 503,
      headers,
    });
  }
  const day = await rateCheck(
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    `bill:po:day:${user.id}`,
    BILLING_RATE_PER_DAY,
    86_400,
  );
  if (day === 'limited') {
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
  }
  if (day === 'error') {
    return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
      status: 503,
      headers,
    });
  }

  const profile = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, user.id);
  if (!profile?.stripe_customer_id) {
    return new Response(JSON.stringify({ error: 'no stripe customer' }), { status: 400, headers });
  }

  const portal = await stripeRequest<{ url?: string }>(secret, 'POST', '/billing_portal/sessions', {
    customer: profile.stripe_customer_id,
    return_url: `${site}/`,
  });
  if (!portal.url) {
    return new Response(JSON.stringify({ error: 'portal session missing url' }), {
      status: 502,
      headers,
    });
  }
  console.log(`portal session created user=${user.id.slice(0, 8)}`);
  return new Response(JSON.stringify({ url: portal.url }), { status: 200, headers });
});
