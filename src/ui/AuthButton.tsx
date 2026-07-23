/*
 * AuthButton.tsx — ヘッダー右上のログイン/アカウント UI
 *
 * 表示規則:
 *   disabled  → 何も描画しない(App の見た目が従来と完全同一 = 必須要件)
 *   anonymous → 「ログイン」ボタン → AuthDialog（Google/Apple/メール）
 *   loading   → 無効化した同ボタン
 *   signedIn  → 表示名 + （あれば）端末レートのコンパクトなメニュー
 *
 * 【レート表示の正（ADR 0002）】
 * ヘッダーに出すのは対局で変動する端末レートのみ。クラウドの初期設定値はメニュー内の
 * 「初期設定」として分離し、動くレートと見せない（完成度ループ・初見 UX）。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';
import { loadRating } from '../core/storage';
import { AuthDialog } from './AuthDialog';

export function AuthButton({
  onOpenStrength,
}: {
  /** プレイ分析画面を開く（任意。未指定ならメニュー項目を出さない）。 */
  onOpenStrength?: () => void;
} = {}) {
  const { status, profile, signOut, error } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (status === 'disabled') return null;

  if (status === 'anonymous' || status === 'loading') {
    return (
      <div className="flex items-center gap-2">
        {error && !dialogOpen && (
          <span className="max-w-32 truncate text-xs text-[var(--q-miss-fg)]" title={error}>
            ログイン失敗
          </span>
        )}
        <button
          type="button"
          disabled={status === 'loading'}
          onClick={() => setDialogOpen(true)}
          className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:border-ai hover:text-on-surface disabled:opacity-50"
        >
          {status === 'loading' ? '確認中…' : 'ログイン'}
        </button>
        <AuthDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      </div>
    );
  }

  const name = profile?.display_name ?? 'プレイヤー';
  const localRating = loadRating();
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => setMenuOpen((v) => !v)}
        className="focus-ai flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:border-ai"
      >
        <span className="max-w-28 truncate font-medium">{name}</span>
        {localRating && (
          <span className="text-xs text-muted" title="この端末の対局レート（対局結果で変動）">
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
          className="absolute right-0 top-full z-40 mt-1 flex w-56 flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-xl"
        >
          <div className="text-xs text-muted">
            <p className="truncate font-medium text-on-surface">{name}</p>
            {localRating && (
              <p className="mt-0.5">
                対局レート:{' '}
                <span className="font-semibold text-on-surface">{localRating.rating}</span>
                <span className="ml-1">({localRating.games}局・この端末)</span>
              </p>
            )}
            {profile && (
              <p className="mt-0.5">
                初期設定: <span className="font-semibold text-ai">{profile.rating}</span>
                <span className="ml-1 text-subtle">（クラウド・固定）</span>
              </p>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-subtle">
              対局の勝敗は端末レートに反映されます。クラウドの初期設定はオンボーディング時の値です。
            </p>
          </div>
          {onOpenStrength && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenStrength();
              }}
              className="focus-ai min-h-11 rounded-lg border border-border px-3 text-left text-sm text-muted transition-colors hover:border-ai hover:text-on-surface"
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
            className="focus-ai min-h-11 rounded-lg border border-border px-3 text-left text-sm text-muted transition-colors hover:border-ai hover:text-on-surface"
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
