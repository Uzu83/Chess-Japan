/**
 * BillingButtons — ヘッダーの Pro アップグレード / サブスク管理
 *
 * Pro はいきなり Checkout せず、相場比較つきダイアログを挟む（納得→開始）。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';
import { isBillingConfigured, openCustomerPortal, startCheckout } from '../billing/client';
import { ProUpgradeDialog } from './ProUpgradeDialog';

export function BillingButtons() {
  const { status, profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

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
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      {isPro ? (
        <button
          type="button"
          disabled={busy}
          className="focus-ai rounded-xl border border-border px-3 py-1 text-sm text-on-surface transition-colors hover:border-ai disabled:opacity-50"
          onClick={() => void run(openCustomerPortal)}
        >
          サブスク管理
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          className="focus-ai rounded-xl border border-ai px-3 py-1 text-sm font-medium text-ai transition-colors hover:bg-ai hover:text-white disabled:opacity-50"
          onClick={() => setUpgradeOpen(true)}
          title="月額 ¥480 — 個人レッスン1回より気軽に"
        >
          Pro
        </button>
      )}
      {err && (
        <span
          className="max-w-[14rem] text-xs leading-snug text-[var(--q-blnd-fg)] sm:max-w-xs"
          title={err}
        >
          {err}
        </span>
      )}
      <ProUpgradeDialog
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        busy={busy}
        onConfirm={() => {
          void run(async () => {
            await startCheckout();
          });
        }}
      />
    </span>
  );
}
