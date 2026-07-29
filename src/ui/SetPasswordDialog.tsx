/*
 * SetPasswordDialog.tsx — パスワード再設定（recovery セッション後）
 *
 * resetPasswordForEmail → メールリンク → PASSWORD_RECOVERY で表示。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';

export function SetPasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!open) return null;

  const run = async () => {
    setErr(null);
    if (password.length < 8) {
      setErr('パスワードは8文字以上にしてください');
      return;
    }
    if (password !== confirm) {
      setErr('確認用パスワードが一致しません');
      return;
    }
    setBusy(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-[color:color-mix(in_oklab,var(--color-ink)_45%,transparent)] backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="set-password-title"
        className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-card-hover"
      >
        <h2 id="set-password-title" className="font-display text-lg tracking-tight text-on-surface">
          新しいパスワード
        </h2>
        {done ? (
          <>
            <p className="mt-2 text-sm text-muted">パスワードを更新しました。</p>
            <button
              type="button"
              onClick={onClose}
              className="focus-ai mt-5 min-h-11 w-full rounded-xl bg-ai text-sm font-medium text-white"
            >
              閉じる
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              メールのリンクから来た方は、ここで新しいパスワードを設定できます。
            </p>
            <label className="mt-4 block text-xs text-muted">
              新パスワード
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="focus-ai mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm"
              />
            </label>
            <label className="mt-3 block text-xs text-muted">
              確認
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="focus-ai mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm"
              />
            </label>
            {err && (
              <p className="mt-3 text-xs text-[var(--q-blnd-fg)]" role="alert">
                {err}
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run()}
              className="focus-ai mt-5 min-h-11 w-full rounded-xl bg-ai text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? '更新中…' : 'パスワードを保存'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
