/**
 * BillingButtons — ヘッダーの Pro アップグレード / サブスク管理
 *
 * Pro はいきなり Checkout せず、相場比較つきダイアログを挟む（納得→開始）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/authState';
import { isBillingConfigured, openCustomerPortal, startCheckout } from '../billing/client';
import { AuthDialog } from './AuthDialog';
import { ProUpgradeDialog } from './ProUpgradeDialog';

/*
 * 未ログインから Pro を押したあとの「ログインしたら決済へ戻る」印。
 * OAuth はページを離れるので sessionStorage。メールログインは同一ページなので ref でも持つ。
 * ダイアログを閉じたら捨てる（普通のログイン導線で突然 Checkout が始まらないように）。
 */
const RESUME_CHECKOUT_KEY = 'cj:resume-checkout';

function markResumeCheckout(): void {
  try {
    sessionStorage.setItem(RESUME_CHECKOUT_KEY, '1');
  } catch {
    /* プライベートモード等。ref 側で同一ページの再開は残る */
  }
}

function consumeResumeCheckout(): boolean {
  try {
    const on = sessionStorage.getItem(RESUME_CHECKOUT_KEY) === '1';
    if (on) sessionStorage.removeItem(RESUME_CHECKOUT_KEY);
    return on;
  } catch {
    return false;
  }
}

function clearResumeCheckout(): void {
  try {
    sessionStorage.removeItem(RESUME_CHECKOUT_KEY);
  } catch {
    /* ignore */
  }
}

export function BillingButtons() {
  const { status, profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const resumeAfterAuth = useRef(false);
  const signedIn = status === 'signedIn';
  const isPro = signedIn && profile?.plan === 'pro' && profile?.stripe_status === 'active';

  const run = useCallback(async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /*
   * ログイン完了後に Checkout へ戻る（GPT 監査 2026-08-13 P2）。
   *   未ログインの確定は AuthDialog を開くだけだと、メールログイン後もダイアログが残り、
   *   OAuth 戻りでは意図が消える。訪問者は料金ページまで来たのに、もう一度 Pro を探さないと
   *   決済が始まらない。
   */
  useEffect(() => {
    if (!isBillingConfigured() || status === 'disabled' || !signedIn) return;
    const fromRef = resumeAfterAuth.current;
    resumeAfterAuth.current = false;
    const fromStore = consumeResumeCheckout();
    if (!fromRef && !fromStore) return;
    setAuthOpen(false);
    setUpgradeOpen(false);
    void run(startCheckout);
  }, [signedIn, status, run]);

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
            resumeAfterAuth.current = true;
            markResumeCheckout();
            setUpgradeOpen(false);
            setAuthOpen(true);
            return;
          }
          void run(async () => {
            await startCheckout();
          });
        }}
      />
      <AuthDialog
        open={authOpen}
        onClose={() => {
          setAuthOpen(false);
          if (!signedIn) {
            resumeAfterAuth.current = false;
            clearResumeCheckout();
          }
        }}
      />
    </span>
  );
}
