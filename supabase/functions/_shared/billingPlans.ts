/**
 * billingPlans.ts — 有料プラン定数と entitlement 判定（Deno / Node 両用）
 *
 * WHY 純関数隔離: Edge と vitest で同じ枠・モデル解決を共有し、クライアントに
 * model を渡さない不変条件を壊さない（ADR 0005）。
 */

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

export const STRIPE_STATUSES = ['none', 'active', 'past_due', 'canceled'] as const;
export type StripeStatus = (typeof STRIPE_STATUSES)[number];

/** 匿名 / free: IP 日次（決定値）。 */
export const FREE_DAY_LIMIT = 50;
/** Pro: Flash 系の日次。 */
export const PRO_FLASH_DAY_LIMIT = 150;
/** Pro: 高品質モデルの月次（厳キャップ・原価防衛）。 */
export const PRO_DEEP_MONTH_LIMIT = 30;

export const RATE_WINDOW_DAY = 86_400;
export const RATE_WINDOW_MONTH = 2_592_000; // 30d

export type Depth = 'standard' | 'deep';

export interface Entitlement {
  plan: Plan;
  /** explain で使う実効プラン（past_due は free 扱い）。 */
  effectivePlan: Plan;
  stripeStatus: StripeStatus;
}

export function parsePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

export function parseStripeStatus(raw: unknown): StripeStatus {
  if (raw === 'active' || raw === 'past_due' || raw === 'canceled') return raw;
  return 'none';
}

/** past_due / canceled / none → free。active + plan=pro のみ Pro。 */
export function resolveEntitlement(plan: Plan, stripeStatus: StripeStatus): Entitlement {
  const effectivePlan: Plan = plan === 'pro' && stripeStatus === 'active' ? 'pro' : 'free';
  return { plan, effectivePlan, stripeStatus };
}

/**
 * depth=deep かつ Pro 有効なら高品質モデル。それ以外は Flash 系。
 * クライアントは model 名を送らない（depth enum のみ）。
 */
export function shouldUseDeepModel(effectivePlan: Plan, depth: Depth): boolean {
  return effectivePlan === 'pro' && depth === 'deep';
}
