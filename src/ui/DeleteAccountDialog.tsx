/*
 * DeleteAccountDialog.tsx — 退会確認
 *
 * 誤タップ防止: 入力欄に DELETE と打たないと実行できない。
 * Pro 契約中は Stripe サブを Edge 側で best-effort キャンセル。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { deleteMyAccount } from '../auth/accountDelete';
import { useAuth } from '../auth/authState';

export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signOut } = useAuth();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const canSubmit = typed.trim() === 'DELETE' && !busy;

  const run = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteMyAccount();
      await signOut();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // AuthButton は sticky+blur ヘッダー内 → body へ出さないと fixed がヘッダーに閉じ込められる。
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto p-4 py-8">
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-[color:color-mix(in_oklab,var(--color-ink)_45%,transparent)] backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-card-hover"
      >
        <h2
          id="delete-account-title"
          className="font-display text-lg tracking-tight text-on-surface"
        >
          アカウントを削除
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          プロフィール・クラウド履歴・ログイン情報を削除します。この操作は取り消せません。Pro
          契約中の場合はサブスクリプションも解約します。
        </p>
        <label className="mt-4 block text-xs text-muted">
          確認のため <span className="font-mono text-on-surface">DELETE</span> と入力
          <input
            type="text"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="focus-ai mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-on-surface"
          />
        </label>
        {err && (
          <p className="mt-3 text-xs text-[var(--q-blnd-fg)]" role="alert">
            {err}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="focus-ai min-h-11 flex-1 rounded-xl border border-border text-sm text-muted hover:text-on-surface"
          >
            やめる
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void run()}
            className="focus-ai min-h-11 flex-1 rounded-xl bg-[var(--q-blnd-fg)] text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? '削除中…' : '完全に削除'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
