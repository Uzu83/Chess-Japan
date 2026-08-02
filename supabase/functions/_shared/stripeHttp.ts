/**
 * stripeHttp.ts — Stripe REST 最小クライアント（Deno Edge）
 *
 * 【運用・安全】
 *   - 既定は sk_test_ / whsec_ のみ受理。sk_live_ は STRIPE_ALLOW_LIVE=1 のときだけ。
 *   - 署名検証は raw body 必須（パース前の文字列）。
 *   - Price ID は secrets（STRIPE_PRICE_ID）。コードに焼かない。
 */

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

export function assertStripeSecretKey(secret: string | undefined, allowLive = false): string {
  if (!secret) throw new StripeConfigError('STRIPE_SECRET_KEY missing');
  if (secret.startsWith('sk_live_') && !allowLive) {
    throw new StripeConfigError(
      'live Stripe key blocked (set STRIPE_ALLOW_LIVE=1 only after Price/Portal verified in test)',
    );
  }
  if (!secret.startsWith('sk_test_') && !secret.startsWith('sk_live_')) {
    throw new StripeConfigError('STRIPE_SECRET_KEY must start with sk_test_ or sk_live_');
  }
  return secret;
}

export function requirePriceId(priceId: string | undefined): string {
  const id = priceId ?? '';
  if (!id.startsWith('price_')) throw new StripeConfigError('STRIPE_PRICE_ID missing or invalid');
  return id;
}

/** Stripe REST は固定ホストのみ（OWASP A10 SSRF）。 */
const STRIPE_API = 'https://api.stripe.com/v1';

export async function stripeRequest<T>(
  secret: string,
  method: string,
  path: string,
  form?: Record<string, string | number | undefined>,
  opts?: { idempotencyKey?: string },
): Promise<T> {
  if (!path.startsWith('/') || path.includes('://') || path.includes('..')) {
    throw new Error('invalid stripe path');
  }
  const body = new URLSearchParams();
  if (form) {
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined || v === '') continue;
      body.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (opts?.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 255);
  }
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json.error?.message ?? `stripe ${method} ${path} failed: ${res.status}`);
  }
  return json;
}

/** Stripe-Signature ヘッダ検証（公式アルゴリズムの最小移植）。 */
export async function verifyStripeWebhook(
  rawBody: string,
  sigHeader: string | null,
  endpointSecret: string,
  toleranceSec = 300,
): Promise<{ type: string; data: { object: Record<string, unknown> }; id: string }> {
  if (!sigHeader) throw new Error('missing stripe-signature');
  if (!endpointSecret.startsWith('whsec_')) throw new Error('invalid webhook secret');
  // OWASP A04: 異常に巨大な body は署名前に拒否（DoS / パースコスト）。
  if (rawBody.length > 256_000) throw new Error('body too large');

  // 署名ローテーション中は Stripe-Signature に v1 が複数付く。
  // Object.fromEntries だと最後の v1 だけ残り、旧 secret 一致が落ちる（監査 M5）。
  let timestamp: string | undefined;
  const v1List: string[] = [];
  for (const part of sigHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1);
    if (k === 't') timestamp = v;
    if (k === 'v1' && v) v1List.push(v);
  }
  if (!timestamp || v1List.length === 0) throw new Error('malformed stripe-signature');

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw new Error('invalid timestamp');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSec) throw new Error('timestamp outside tolerance');

  const signedPayload = `${timestamp}.${rawBody}`;
  // Stripe 公式（stripe-node / docs 手動検証）: HMAC 鍵は whsec_ 付き文字列そのもの（UTF-8）。
  // base64 デコードしない（誤ると正当な webhook が全部落ちる）。
  const keyCopy = new TextEncoder().encode(endpointSecret);
  const mac = await crypto.subtle.importKey(
    'raw',
    keyCopy,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!v1List.some((v1) => timingSafeEqualHex(expected, v1))) throw new Error('signature mismatch');

  const event = JSON.parse(rawBody) as {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  if (!event.type || !event.data?.object || !event.id) throw new Error('invalid event payload');
  return { id: event.id, type: event.type, data: { object: event.data.object } };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type StripeSubscriptionSnapshot = {
  id: string;
  customerId: string | null;
  status: string | null;
  priceId: string | null;
};

/**
 * サブスクリプションの現在状態を Stripe API から取得（webhook の reconcile 用）。
 * イベント payload の古い snapshot で entitlement を上書きしないための正本。
 */
export async function fetchSubscriptionSnapshot(
  secret: string,
  subscriptionId: string,
): Promise<StripeSubscriptionSnapshot | null> {
  if (!subscriptionId.startsWith('sub_')) return null;
  const sub = await stripeRequest<{
    id?: string;
    customer?: string;
    status?: string;
    items?: { data?: { price?: string | { id?: string } }[] };
  }>(secret, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const price = sub.items?.data?.[0]?.price;
  let priceId: string | null = null;
  if (typeof price === 'string' && price.startsWith('price_')) priceId = price;
  else if (price && typeof price === 'object' && typeof price.id === 'string') priceId = price.id;
  return {
    id: typeof sub.id === 'string' ? sub.id : subscriptionId,
    customerId: typeof sub.customer === 'string' ? sub.customer : null,
    status: typeof sub.status === 'string' ? sub.status : null,
    priceId,
  };
}

/** サブスクリプションの Price ID のみ（後方互換ラッパ）。 */
export async function fetchSubscriptionPriceId(
  secret: string,
  subscriptionId: string,
): Promise<string | null> {
  const snap = await fetchSubscriptionSnapshot(secret, subscriptionId);
  return snap?.priceId ?? null;
}
