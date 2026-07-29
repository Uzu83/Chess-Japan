// Supabase Edge: アカウント退会（本人 JWT → service_role で auth.users 削除）
//
// POST /functions/v1/account-delete
//   Authorization: Bearer <user JWT>
//   body: { confirm: "DELETE" }
//
// 流れ:
//   1. JWT 検証（本人のみ）
//   2. 確認フレーズ必須（誤タップ防止）
//   3. 有効 Stripe サブがあれば即時キャンセル（best-effort・失敗でも退会は続行）
//   4. GoTrue admin deleteUser → profiles は ON DELETE CASCADE
//
// 【不変】クライアントに service_role を渡さない。profiles DELETE GRANT も足さない。

import { getAuthUser } from '../_shared/authUser.ts';
import { resolveCors } from '../_shared/cors.ts';
import { rateCheck } from '../_shared/rateCheck.ts';
import { readBodyCapped } from '../_shared/readBodyCapped.ts';
import { assertStripeSecretKey, stripeRequest } from '../_shared/stripeHttp.ts';
import { fetchProfileBilling } from '../_shared/stripeProfile.ts';
import { clientIp } from '../_shared/turnstile.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SB_PUBLISHABLE_KEY');
const IS_HOSTED = Boolean(Deno.env.get('SB_EXECUTION_ID') || Deno.env.get('DENO_DEPLOYMENT_ID'));

const RATE_PER_DAY = Number(Deno.env.get('ACCOUNT_DELETE_RATE_PER_DAY') ?? '3');
const RATE_PER_MIN_IP = Number(Deno.env.get('ACCOUNT_DELETE_RATE_PER_MIN_IP') ?? '5');
const MAX_BODY = 4_096;

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

  const user = await getAuthUser(req, {
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
  });
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });
  }

  const ip = clientIp(req);
  for (const [key, limit, window] of [
    [`acctdel:day:${user.id}`, RATE_PER_DAY, 86_400],
    [`acctdel:ip:${ip}`, RATE_PER_MIN_IP, 60],
  ] as const) {
    const r = await rateCheck(SUPABASE_URL, SERVICE_ROLE_KEY, key, limit, window);
    if (r === 'limited') {
      return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
    }
    if (r === 'error') {
      return new Response(JSON.stringify({ error: 'service unavailable' }), {
        status: 503,
        headers,
      });
    }
  }

  const raw = await readBodyCapped(req, MAX_BODY);
  if (raw === null) {
    return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413, headers });
  }
  let body: { confirm?: unknown };
  try {
    body = JSON.parse(raw) as { confirm?: unknown };
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers });
  }
  if (body.confirm !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'confirmation required' }), {
      status: 400,
      headers,
    });
  }

  // Stripe サブ解約は best-effort。課金キー未設定でも退会自体は通す。
  try {
    const stripeSecret = assertStripeSecretKey(
      Deno.env.get('STRIPE_SECRET_KEY') ?? undefined,
      Deno.env.get('STRIPE_ALLOW_LIVE') === '1',
    );
    const billing = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, user.id);
    const subId = billing?.stripe_subscription_id;
    if (subId && typeof subId === 'string' && subId.startsWith('sub_')) {
      await stripeRequest(stripeSecret, 'DELETE', `/subscriptions/${encodeURIComponent(subId)}`, {
        invoice_now: 'false',
        prorate: 'true',
      });
    }
  } catch (e) {
    console.error('account-delete stripe cancel skipped', e instanceof Error ? e.name : 'error');
  }

  const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!del.ok) {
    console.error('account-delete admin failed', del.status);
    return new Response(JSON.stringify({ error: 'delete failed' }), { status: 502, headers });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
});
