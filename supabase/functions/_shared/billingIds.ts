/**
 * billingIds.ts — Stripe metadata / PostgREST に載せる ID の形チェック
 *
 * OWASP A03/A01: 任意文字列を path / filter に載せない。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSupabaseUserId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Stripe customer id（cus_…）の最低限チェック。 */
export function isStripeCustomerId(id: string): boolean {
  return /^cus_[A-Za-z0-9]+$/.test(id) && id.length <= 255;
}

/** Stripe event id（evt_…）。 */
export function isStripeEventId(id: string): boolean {
  return /^evt_[A-Za-z0-9]+$/.test(id) && id.length <= 255;
}
