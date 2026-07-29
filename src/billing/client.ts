/**
 * billing/client.ts — Stripe Checkout / Portal（Edge）呼び出し
 *
 * 秘密キーは一切触らない。フロントは JWT のみ送り、決済 UI は Stripe hosted。
 */
import { getSupabase, isAuthConfigured } from '../auth/supabaseClient';

function supabaseUrl(): string | undefined {
  return import.meta.env.VITE_SUPABASE_URL as string | undefined;
}
function supabaseAnon(): string | undefined {
  return import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
}

/** Billing UI を出すか（Supabase + Auth が必要）。 */
export function isBillingConfigured(): boolean {
  return isAuthConfigured() && Boolean(supabaseUrl() && supabaseAnon());
}

async function postBilling(path: 'stripe-checkout' | 'stripe-portal'): Promise<string> {
  const url = supabaseUrl();
  const anon = supabaseAnon();
  if (!url || !anon) throw new Error('Supabase 未設定');

  const supabase = await getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('ログインが必要です');

  const res = await fetch(`${url}/functions/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: '{}',
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok) throw new Error(body.error || `billing error (${res.status})`);
  if (!body.url) throw new Error('リダイレクト URL がありません');
  return body.url;
}

export async function startCheckout(): Promise<void> {
  const checkoutUrl = await postBilling('stripe-checkout');
  window.location.assign(checkoutUrl);
}

export async function openCustomerPortal(): Promise<void> {
  const portalUrl = await postBilling('stripe-portal');
  window.location.assign(portalUrl);
}
