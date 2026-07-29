/**
 * BillingButtons — ヘッダーの Pro アップグレード / サブスク管理
 *
 * Stripe Checkout / Portal は hosted。ここではリダイレクトするだけ。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';
import { isBillingConfigured, openCustomerPortal, startCheckout } from '../billing/client';

export function BillingButtons() {
  const { status, profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!isBillingConfigured()) return null;
  if (status !== 'signedIn') return null;

  const isPro = profile?.plan === 'pro' && profile?.stripe_status === 'active';

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      // 成功時は Stripe へ遷移するため実質到達しないが、失敗・例外時の busy 固着を防ぐ。
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      {isPro ? (
        <button
          type="button"
          disabled={busy}
          className="focus-ai rounded border border-outline px-3 py-1 text-sm text-on-surface transition-colors hover:bg-surface-container disabled:opacity-50"
          onClick={() => void run(openCustomerPortal)}
        >
          サブスク管理
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          className="focus-ai rounded border border-ai px-3 py-1 text-sm font-medium text-ai transition-colors hover:bg-ai hover:text-white disabled:opacity-50 dark:hover:bg-ai-dim"
          onClick={() => void run(startCheckout)}
          title="月額 ¥480（Flash 厚枠 + 深掘り月30回）"
        >
          Pro
        </button>
      )}
      {err && (
        <span className="max-w-[14rem] text-xs leading-snug text-error sm:max-w-xs" title={err}>
          {err}
        </span>
      )}
    </span>
  );
}
