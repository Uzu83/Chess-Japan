/*
 * AuthDialog.tsx — 多方式ログインダイアログ
 *
 * Google / Apple / メール+パスワード / マジックリンク / パスワード再設定。
 * パスキー・Manual Linking は出さない（後続）。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';
import type { EmailAuthMode } from '../auth/authState';

const oauthGoogleEnabled = import.meta.env.VITE_OAUTH_GOOGLE_ENABLED === '1';
const oauthAppleEnabled = import.meta.env.VITE_OAUTH_APPLE_ENABLED === '1';
const hasOAuth = oauthGoogleEnabled || oauthAppleEnabled;

type Panel = 'auth' | 'forgot';

export function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    signInWithGoogle,
    signInWithApple,
    signInWithEmailPassword,
    signInWithEmailOtp,
    resetPassword,
    error,
    status,
  } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<EmailAuthMode>('signin');
  const [panel, setPanel] = useState<Panel>('auth');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  if (!open) return null;

  const disabled = busy || status === 'loading';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setInfo(null);
    try {
      await fn();
    } catch {
      // error は AuthContext 側
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-[color:color-mix(in_oklab,var(--color-ink)_50%,transparent)] backdrop-blur-[3px] transition-opacity"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
        className="relative z-10 w-full max-w-md animate-[sheet-up_280ms_cubic-bezier(0.22,1,0.36,1)] rounded-t-3xl border border-border bg-surface p-6 shadow-card-hover sm:rounded-3xl"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="font-display text-[11px] tracking-[0.18em] text-subtle uppercase">
              Chess-Japan
            </p>
            <h2
              id="auth-dialog-title"
              className="mt-1 font-display text-xl tracking-tight text-on-surface"
            >
              {panel === 'forgot'
                ? 'パスワード再設定'
                : mode === 'signin'
                  ? 'ログイン'
                  : 'アカウント作成'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ai rounded-lg px-2 py-1 text-sm text-muted hover:text-on-surface"
          >
            閉じる
          </button>
        </div>

        {panel === 'forgot' ? (
          <>
            <p className="mb-4 text-sm leading-relaxed text-muted">
              登録メールに再設定リンクを送ります。リンク先で新しいパスワードを設定できます。ログインだけならマジックリンクでも入れます。
            </p>
            <label className="mb-3 block text-xs text-muted">
              メール
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="focus-ai mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-on-surface"
              />
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await resetPassword(email);
                  setInfo('再設定メールを送信しました');
                })
              }
              className="focus-ai mb-2 min-h-11 w-full rounded-xl bg-ai px-3 text-sm font-medium text-white shadow-btn transition hover:bg-ai-hover disabled:opacity-50"
            >
              再設定メールを送る
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await signInWithEmailOtp(email);
                  setInfo('マジックリンクを送信しました');
                })
              }
              className="focus-ai mb-3 min-h-11 w-full rounded-xl border border-border px-3 text-sm text-muted transition hover:border-ai hover:text-on-surface disabled:opacity-50"
            >
              代わりにマジックリンクでログイン
            </button>
            <button
              type="button"
              onClick={() => {
                setPanel('auth');
                setInfo(null);
              }}
              className="focus-ai w-full text-center text-xs text-ai hover:underline"
            >
              ログインに戻る
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {oauthGoogleEnabled && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run(() => signInWithGoogle())}
                  className="focus-ai min-h-11 rounded-xl border border-border px-3 text-sm font-medium text-on-surface transition hover:border-ai disabled:opacity-50"
                >
                  Googleで続ける
                </button>
              )}
              {oauthAppleEnabled && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run(() => signInWithApple())}
                  className="focus-ai min-h-11 rounded-xl border border-border px-3 text-sm font-medium text-on-surface transition hover:border-ai disabled:opacity-50"
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
                className="focus-ai mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-on-surface"
              />
            </label>
            <label className="mb-1 block text-xs text-muted">
              パスワード
              <input
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="focus-ai mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-on-surface"
              />
            </label>
            {mode === 'signin' && (
              <button
                type="button"
                onClick={() => {
                  setPanel('forgot');
                  setInfo(null);
                }}
                className="focus-ai mb-3 text-left text-xs text-ai hover:underline"
              >
                パスワードを忘れた方
              </button>
            )}

            <button
              type="button"
              disabled={disabled}
              onClick={() => void run(() => signInWithEmailPassword(email, password, mode))}
              className="focus-ai mb-2 min-h-11 w-full rounded-xl bg-ai px-3 text-sm font-medium text-white shadow-btn transition hover:bg-ai-hover disabled:opacity-50"
            >
              {mode === 'signin' ? 'メールでログイン' : '新規登録'}
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await signInWithEmailOtp(email);
                  setInfo('マジックリンクを送信しました');
                })
              }
              className="focus-ai mb-3 min-h-11 w-full rounded-xl border border-border px-3 text-sm text-muted transition hover:border-ai hover:text-on-surface disabled:opacity-50"
            >
              マジックリンクを送る
            </button>

            <button
              type="button"
              onClick={() => setMode((m) => (m === 'signin' ? 'signup' : 'signin'))}
              className="focus-ai w-full text-center text-xs text-ai hover:underline"
            >
              {mode === 'signin' ? 'アカウントを作成する' : 'すでにアカウントがある方はログイン'}
            </button>
          </>
        )}

        {(error || info) && (
          <p
            className={`mt-4 text-xs leading-relaxed ${
              info && !error ? 'text-ai' : 'text-[var(--q-blnd-fg)]'
            }`}
            role="status"
          >
            {error ?? info}
          </p>
        )}
      </div>
    </div>
  );
}
