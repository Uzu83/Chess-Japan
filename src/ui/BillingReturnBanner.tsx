/*
 * BillingReturnBanner — Stripe Checkout 戻り（?billing=success|cancel）の告知
 *
 * Checkout の success_url / cancel_url が /?billing=… に来る前提（Edge 側）。
 * success 時は webhook 反映ラグがあり得るので、signedIn になったら refreshProfile。
 * URL の billing は初回マウントで消費し、auth の loading→signedIn でも再消費しない。
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/authState';

function consumeBillingParam(): 'success' | 'cancel' | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('billing');
  if (raw !== 'success' && raw !== 'cancel') return null;
  url.searchParams.delete('billing');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  return raw;
}

export function BillingReturnBanner() {
  const { status, refreshProfile } = useAuth();
  // 初回だけ URL を読む（status 変化で再実行しない）。
  const [kind] = useState<'success' | 'cancel' | null>(() => consumeBillingParam());
  const [visible, setVisible] = useState(() => kind !== null);

  useEffect(() => {
    if (kind !== 'success' || status !== 'signedIn') return;
    void refreshProfile();
    // webhook 遅延の吸収（2.5s 後にもう一度）。
    const t = window.setTimeout(() => {
      void refreshProfile();
    }, 2500);
    return () => window.clearTimeout(t);
  }, [kind, status, refreshProfile]);

  useEffect(() => {
    if (!visible) return;
    const t = window.setTimeout(() => setVisible(false), 8000);
    return () => window.clearTimeout(t);
  }, [visible]);

  if (!kind || !visible) return null;

  const text =
    kind === 'success'
      ? 'お支払い手続きが完了しました。Pro の反映まで数秒かかることがあります。'
      : 'お支払いをキャンセルしました。いつでもヘッダーの Pro から再開できます。';

  return (
    <div
      role="status"
      className="border-b border-border bg-ai-bg px-5 py-2 text-center text-sm text-ai dark:bg-ai-deep"
    >
      {text}
      <button
        type="button"
        className="focus-ai ml-3 text-xs underline opacity-80 hover:opacity-100"
        onClick={() => setVisible(false)}
      >
        閉じる
      </button>
    </div>
  );
}
