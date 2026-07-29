// Supabase Edge: Stripe Customer Portal（解約・カード更新）
//
// POST /functions/v1/stripe-portal
//   Authorization: Bearer <user JWT>
//   → { url }
//
// OWASP: docs/security/OWASP-billing.md

import { getAuthUser } from '../_shared/authUser.ts';
import { resolveBillingSiteUrl } from '../_shared/billingSite.ts';
import { resolveCors } from '../_shared/cors.ts';
import { rateCheck } from '../_shared/rateCheck.ts';
import { assertStripeSecretKey, stripeRequest } from '../_shared/stripeHttp.ts';
import { fetchProfileBilling } from '../_shared/stripeProfile.ts';
import { clientIp } from '../_shared/turnstile.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SB_PUBLISHABLE_KEY');
const IS_HOSTED = Boolean(Deno.env.get('SB_EXECUTION_ID') || Deno.env.get('DENO_DEPLOYMENT_ID'));

const BILLING_RATE_PER_MIN = Number(Deno.env.get('BILLING_RATE_PER_MIN') ?? '5');
const BILLING_RATE_PER_DAY = Number(Deno.env.get('BILLING_RATE_PER_DAY') ?? '20');
const BILLING_RATE_PER_MIN_IP = Number(Deno.env.get('BILLING_RATE_PER_MIN_IP') ?? '10');

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = resolveCors({
    origin,
    allowedOrigins: ALLOWED_ORIGINS,
    isHosted: IS_HOSTED,
    allowHeaders: 'authorization, content-type, apikey',
  });
  const headers = cors.headers;
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: cors.allowed ? 204 : 403, headers });
  }
  if (!cors.allowed) {
    return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers });
  }
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

  const ip = clientIp(req);
  for (const [key, limit, window] of [
    [`bill:po:min:${user.id}`, BILLING_RATE_PER_MIN, 60],
    [`bill:po:ip:${ip}`, BILLING_RATE_PER_MIN_IP, 60],
    [`bill:po:day:${user.id}`, BILLING_RATE_PER_DAY, 86_400],
  ] as const) {
    const r = await rateCheck(SUPABASE_URL, SERVICE_ROLE_KEY, key, limit, window);
    if (r === 'limited') {
      return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
    }
    if (r === 'error') {
      return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
        status: 503,
        headers,
      });
    }
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
