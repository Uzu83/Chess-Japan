/**
 * stripeProfile.ts — profiles の Stripe 列を service_role で更新/読取
 *
 * 【不変】HTTP 失敗は throw（null に潰さない）。null は「行が無い」だけ。
 * patch は return=representation で 0 行を失敗扱い（消失 profile の偽成功防止）。
 */

import {
  type Plan,
  type StripeStatus,
  parsePlan,
  parseStripeStatus,
  resolveEntitlement,
} from './billingPlans.ts';

export interface ProfileBilling {
  id: string;
  plan: Plan;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_status: StripeStatus;
}

function sbHeaders(serviceRole: string): Record<string, string> {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function rowToProfile(row: Record<string, unknown>): ProfileBilling | null {
  if (typeof row.id !== 'string') return null;
  return {
    id: row.id,
    plan: parsePlan(row.plan),
    stripe_customer_id: typeof row.stripe_customer_id === 'string' ? row.stripe_customer_id : null,
    stripe_subscription_id:
      typeof row.stripe_subscription_id === 'string' ? row.stripe_subscription_id : null,
    stripe_status: parseStripeStatus(row.stripe_status),
  };
}

export async function fetchProfileBilling(
  supabaseUrl: string,
  serviceRole: string,
  userId: string,
): Promise<ProfileBilling | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,plan,stripe_customer_id,stripe_subscription_id,stripe_status`,
    { headers: sbHeaders(serviceRole) },
  );
  if (!res.ok) throw new Error(`fetchProfileBilling failed: ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  const row = rows[0];
  return row ? rowToProfile(row) : null;
}

export async function fetchProfileByCustomerId(
  supabaseUrl: string,
  serviceRole: string,
  customerId: string,
): Promise<ProfileBilling | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id,plan,stripe_customer_id,stripe_subscription_id,stripe_status`,
    { headers: sbHeaders(serviceRole) },
  );
  if (!res.ok) throw new Error(`fetchProfileByCustomerId failed: ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  const row = rows[0];
  return row ? rowToProfile(row) : null;
}

export async function patchProfileBilling(
  supabaseUrl: string,
  serviceRole: string,
  userId: string,
  patch: Partial<{
    plan: Plan;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_status: StripeStatus;
  }>,
): Promise<boolean> {
  const res = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: sbHeaders(serviceRole),
    body: JSON.stringify(patch),
  });
  if (!res.ok) return false;
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

export function isProEntitled(profile: ProfileBilling): boolean {
  return resolveEntitlement(profile.plan, profile.stripe_status).effectivePlan === 'pro';
}
