/*
 * AuthDialog.tsx — 多方式ログインダイアログ
 *
 * 初版: Google / Apple / メール+パスワード / マジックリンク。
 * パスキー・Manual Linking は出さない（Codex F005/F006・後続）。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';
import type { EmailAuthMode } from '../auth/authState';

const oauthGoogleEnabled = import.meta.env.VITE_OAUTH_GOOGLE_ENABLED === '1';
const oauthAppleEnabled = import.meta.env.VITE_OAUTH_APPLE_ENABLED === '1';
const hasOAuth = oauthGoogleEnabled || oauthAppleEnabled;

export function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    signInWithGoogle,
    signInWithApple,
    signInWithEmailPassword,
    signInWithEmailOtp,
    error,
    status,
  } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<EmailAuthMode>('signin');
  const [busy, setBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);

  if (!open) return null;

  const disabled = busy || status === 'loading';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setLocalMsg(null);
    try {
      await fn();
    } catch {
      // error は AuthContext 側に載る
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
        className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 id="auth-dialog-title" className="text-base font-semibold text-on-surface">
            {mode === 'signin' ? 'ログイン' : 'アカウント作成'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="focus-ai rounded px-2 py-1 text-sm text-muted hover:text-on-surface"
          >
            閉じる
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {oauthGoogleEnabled && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run(() => signInWithGoogle())}
              className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm font-medium text-on-surface transition-colors hover:border-ai disabled:opacity-50"
            >
              Googleで続ける
            </button>
          )}
          {oauthAppleEnabled && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run(() => signInWithApple())}
              className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm font-medium text-on-surface transition-colors hover:border-ai disabled:opacity-50"
            >
              Appleで続ける
            </button>
          )}
        </div>

        {hasOAuth && (
          <div className="my-4 flex items-center gap-3 text-xs text-subtle">
            <span className="h-px flex-1 bg-border" />
            または
            <span className="h-px flex-1 bg-border" />
          </div>
        )}

        <label className="mb-2 block text-xs text-muted">
          メール
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="focus-ai mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-on-surface"
          />
        </label>
        <label className="mb-3 block text-xs text-muted">
          パスワード
          <input
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="focus-ai mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-on-surface"
          />
        </label>

        <button
          type="button"
          disabled={disabled}
          onClick={() => void run(() => signInWithEmailPassword(email, password, mode))}
          className="focus-ai mb-2 min-h-11 w-full rounded-lg bg-ai px-3 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50 dark:bg-ai-dim"
        >
          {mode === 'signin' ? 'メールでログイン' : '新規登録'}
        </button>

        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              await signInWithEmailOtp(email);
              setLocalMsg('マジックリンクを送信しました');
            })
          }
          className="focus-ai mb-3 min-h-11 w-full rounded-lg border border-border px-3 text-sm text-muted transition-colors hover:border-ai hover:text-on-surface disabled:opacity-50"
        >
          マジックリンクを送る
        </button>

        <button
          type="button"
          onClick={() => setMode((m) => (m === 'signin' ? 'signup' : 'signin'))}
          className="focus-ai w-full text-center text-xs text-ai underline-offset-2 hover:underline"
        >
          {mode === 'signin' ? 'アカウントを作成する' : 'すでにアカウントがある方はログイン'}
        </button>

        {(error || localMsg) && (
          <p className="mt-3 text-xs leading-relaxed text-[var(--q-miss-fg)]" role="status">
            {error ?? localMsg}
          </p>
        )}
      </div>
    </div>
  );
}
