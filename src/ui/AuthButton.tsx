/*
 * AuthButton.tsx — ヘッダー右上のログイン/アカウント UI
 *
 * disabled → 非表示 / anonymous → ログイン / signedIn → メニュー
 * メニューに退会を含む。無料ユーザーには Pro 案内（BillingButtons と同じ Checkout 経路）。
 */
import { useRef, useState } from 'react';
import { useAuth } from '../auth/authState';
import { isBillingConfigured, startCheckout } from '../billing/client';
import { loadRating } from '../core/storage';
import { AuthDialog } from './AuthDialog';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { ProUpgradeDialog } from './ProUpgradeDialog';

export function AuthButton({
  onOpenStrength,
}: {
  onOpenStrength?: () => void;
} = {}) {
  const { status, profile, signOut, error } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingErr, setBillingErr] = useState<string | null>(null);
  /** メニュー内 Pro 導線は開くとメニューごと消えるため、閉じたあとここに戻す（Codex #90 medium）。 */
  const accountBtnRef = useRef<HTMLButtonElement>(null);

  if (status === 'disabled') return null;

  if (status === 'anonymous' || status === 'loading') {
    return (
      <div className="flex items-center gap-2">
        {error && !dialogOpen && (
          <span className="max-w-32 truncate text-xs text-[var(--q-blnd-fg)]" title={error}>
            ログイン失敗
          </span>
        )}
        <button
          type="button"
          disabled={status === 'loading'}
          onClick={() => setDialogOpen(true)}
          className="focus-ai min-h-11 rounded-xl border border-border bg-surface px-3.5 text-sm font-medium text-on-surface transition hover:border-ai disabled:opacity-50"
        >
          {status === 'loading' ? '確認中…' : 'ログイン'}
        </button>
        <AuthDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      </div>
    );
  }

  const name = profile?.display_name ?? 'プレイヤー';
  const localRating = loadRating();
  const isPro = profile?.plan === 'pro' && profile?.stripe_status === 'active';
  const showProUpgrade = !isPro && isBillingConfigured();

  const runBilling = async (fn: () => Promise<void>) => {
    setBillingErr(null);
    setBillingBusy(true);
    try {
      await fn();
    } catch (e) {
      setBillingErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBillingBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={accountBtnRef}
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => setMenuOpen((v) => !v)}
        className="focus-ai flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm text-on-surface transition hover:border-ai"
      >
        <span className="max-w-28 truncate font-medium">{name}</span>
        {isPro && (
          <span className="rounded-md bg-ai-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ai">
            Pro
          </span>
        )}
        {localRating && (
          <span className="text-xs text-muted" title="この端末の対局レート">
            {localRating.rating}
          </span>
        )}
      </button>

      {menuOpen && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 cursor-default"
        />
      )}
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 flex w-60 flex-col gap-2 rounded-2xl border border-border bg-surface p-3.5 shadow-card-hover"
        >
          <div className="text-xs text-muted">
            <p className="truncate font-display text-sm text-on-surface">{name}</p>
            {localRating && (
              <p className="mt-1">
                対局レート:{' '}
                <span className="font-semibold text-on-surface">{localRating.rating}</span>
                <span className="ml-1">({localRating.games}局・この端末)</span>
              </p>
            )}
            {profile && (
              <p className="mt-0.5">
                初期設定: <span className="font-semibold text-ai">{profile.rating}</span>
                <span className="ml-1 text-subtle">（クラウド）</span>
              </p>
            )}
            <p className="mt-0.5">
              プラン:{' '}
              <span className="font-semibold text-on-surface">{isPro ? 'Pro' : '無料'}</span>
            </p>
            {showProUpgrade && (
              <p className="mt-1 text-[11px] leading-snug text-subtle">
                深掘り解説は Pro 限定（月額 ¥480）
              </p>
            )}
          </div>
          {showProUpgrade && (
            <button
              type="button"
              role="menuitem"
              disabled={billingBusy}
              onClick={() => {
                setMenuOpen(false);
                setUpgradeOpen(true);
              }}
              className="focus-ai min-h-11 rounded-xl border border-ai px-3 text-left text-sm font-medium text-ai transition hover:bg-ai-bg disabled:opacity-50 dark:hover:bg-ai-deep"
              title="月額 ¥480 — 個人レッスン1回より気軽に"
            >
              Pro にアップグレード
            </button>
          )}
          {onOpenStrength && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenStrength();
              }}
              className="focus-ai min-h-11 rounded-xl border border-border px-3 text-left text-sm text-muted transition hover:border-ai hover:text-on-surface"
            >
              プレイ分析
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void signOut();
            }}
            className="focus-ai min-h-11 rounded-xl border border-border px-3 text-left text-sm text-muted transition hover:border-ai hover:text-on-surface"
          >
            ログアウト
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
            className="focus-ai min-h-11 rounded-xl border border-border px-3 text-left text-sm text-[var(--q-blnd-fg)] transition hover:border-[var(--q-blnd-fg)]"
          >
            アカウント削除
          </button>
        </div>
      )}
      <DeleteAccountDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} />
      {showProUpgrade && (
        <ProUpgradeDialog
          open={upgradeOpen}
          onClose={() => {
            setUpgradeOpen(false);
            setBillingErr(null);
            // メニュー項目は既に unmount 済みなので、常設のアカウントボタンへ戻す
            accountBtnRef.current?.focus();
          }}
          busy={billingBusy}
          error={billingErr}
          onConfirm={() => {
            void runBilling(async () => {
              await startCheckout();
            });
          }}
        />
      )}
    </div>
  );
}
