// Supabase Edge: アカウント退会（本人 JWT → service_role で auth.users 削除）
//
// POST /functions/v1/account-delete
//   Authorization: Bearer <user JWT>
//   body: { confirm: "DELETE" }
//
// 流れ:
//   1. JWT 検証（本人のみ）+ 発行からの経過が短いこと（再認証相当・盗難 JWT 対策）
//   2. 確認フレーズ必須（誤タップ防止）
//   3. 有効 Stripe サブがあれば即時キャンセル（失敗時は退会しない = fail-closed）
//   4. GoTrue admin deleteUser → profiles は ON DELETE CASCADE
//
// 【不変】クライアントに service_role を渡さない。profiles DELETE GRANT も足さない。

import { getAuthUser } from '../_shared/authUser.ts';
import { resolveCors } from '../_shared/cors.ts';
import { isJwtFresh } from '../_shared/jwtClaims.ts';
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
/** 退会に使う JWT の最大年齢（秒）。既定 10 分 — 長寿命セッションの盗難で即退会させない。 */
const MAX_JWT_AGE_SEC = Number(Deno.env.get('ACCOUNT_DELETE_MAX_JWT_AGE_SEC') ?? '600');
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

  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';

  const user = await getAuthUser(req, {
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
  });
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });
  }
  // H3: 有効 JWT でも古いセッションだけでは退会不可。再ログインで新しい iat を得る。
  if (!bearer || !isJwtFresh(bearer, MAX_JWT_AGE_SEC)) {
    return new Response(JSON.stringify({ error: 'reauth required' }), { status: 403, headers });
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

  // Stripe 解約は fail-closed: サブが残ったままユーザー削除すると webhook が迷子になり課金継続しうる。
  const billing = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, user.id);
  const subId = billing?.stripe_subscription_id;
  const hasBillingInterest =
    Boolean(subId && subId.startsWith('sub_')) ||
    billing?.stripe_status === 'active' ||
    billing?.stripe_status === 'past_due' ||
    billing?.plan === 'pro';

  if (hasBillingInterest) {
    if (!subId || !subId.startsWith('sub_')) {
      return new Response(JSON.stringify({ error: 'subscription cancel required' }), {
        status: 409,
        headers,
      });
    }
    try {
      const stripeSecret = assertStripeSecretKey(
        Deno.env.get('STRIPE_SECRET_KEY') ?? undefined,
        Deno.env.get('STRIPE_ALLOW_LIVE') === '1',
      );
      await stripeRequest(stripeSecret, 'DELETE', `/subscriptions/${encodeURIComponent(subId)}`, {
        invoice_now: 'false',
        prorate: 'true',
      });
    } catch (e) {
      console.error('account-delete stripe cancel failed', e instanceof Error ? e.name : 'error');
      return new Response(JSON.stringify({ error: 'subscription cancel failed' }), {
        status: 502,
        headers,
      });
    }
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
