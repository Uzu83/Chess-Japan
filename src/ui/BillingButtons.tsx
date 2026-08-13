/**
 * BillingButtons — ヘッダーの Pro アップグレード / サブスク管理
 *
 * Pro はいきなり Checkout せず、相場比較つきダイアログを挟む（納得→開始）。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';
import { isBillingConfigured, openCustomerPortal, startCheckout } from '../billing/client';
import { AuthDialog } from './AuthDialog';
import { ProUpgradeDialog } from './ProUpgradeDialog';

export function BillingButtons() {
  const { status, profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  if (!isBillingConfigured()) return null;
  /*
   * 未ログインでも Pro の案内へ到達できるようにする（2026-08-13）。
   *
   * WHY 変えたか（収益の穴）: 以前は status !== 'signedIn' で null を返していたため、
   *   **訪問者は料金ページに一度も辿り着けなかった**。トップから見えるのは Ko-fi の「支援する」
   *   だけで、Pro はログイン後のアカウントメニューにしか無い。有料プランを作ってあるのに
   *   購入導線が閉じている状態だった（本番 QA 2026-08-13 の指摘）。
   *
   * auth 自体が無効な環境（disabled）では出さない。ログインできないのに勧めても行き止まりになる。
   */
  if (status === 'disabled') return null;

  const signedIn = status === 'signedIn';
  const isPro = signedIn && profile?.plan === 'pro' && profile?.stripe_status === 'active';

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
        error={err}
        /*
         * 未ログインは決済ではなくログインへ進む。ボタンに「決済が始まる」と読める文言を
         * 出しておいて実際はログイン画面、では信用を落とすので文言も切り替える。
         */
        confirmLabel={signedIn ? 'とりあえず始めてみる' : 'ログインして始める'}
        busyLabel={signedIn ? '決済ページへ…' : '準備中…'}
        onConfirm={() => {
          if (!signedIn) {
            setUpgradeOpen(false);
            setAuthOpen(true);
            return;
          }
          void run(async () => {
            await startCheckout();
          });
        }}
      />
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </span>
  );
}
