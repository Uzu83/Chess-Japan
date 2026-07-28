/*
 * AuthContext.tsx — 認証状態の React コンテキスト
 *
 * 状態マシン(4値):
 *   'disabled'  … VITE_AUTH_ENABLED != '1' 等で auth 機能ごと無効。UI は一切出ない。
 *   'anonymous' … auth は有効だが未ログイン。SDK はロードしない(バンドル戦略)。
 *   'loading'   … セッション復元 or OAuth コールバック処理中。
 *   'signedIn'  … ログイン済み。profile を保持。
 *
 * 初版ログイン方式: Google / Apple / メール+パスワード / メール OTP。
 * パスキー・Manual Linking は後続（Codex F005/F006）。ここには出さない。
 *
 * WHY Provider で SDK を即ロードしないか:
 *   多数派(未ログイン)に supabase-js 53KB gzip を読ませない。ロードの引き金は
 *   ①既存セッションあり ②OAuth コールバック ③ユーザーのログイン操作、の3つだけ。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getSupabase, hasStoredSession, isAuthConfigured, isOAuthCallback } from './supabaseClient';
import { getMyProfile, setInitialRating } from './profile';
import type { Profile, RatingSource } from './profile';
import { AuthContext, disabledState } from './authState';
import type { AuthState, AuthStatus, EmailAuthMode } from './authState';

export function AuthProvider({ children }: { children: ReactNode }) {
  const enabled = isAuthConfigured();

  const [status, setStatus] = useState<AuthStatus>(() => {
    if (!enabled) return 'disabled';
    return hasStoredSession() || isOAuthCallback() ? 'loading' : 'anonymous';
  });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);
  const bootPromiseRef = useRef<Promise<void> | null>(null);

  const bootSession = useCallback((): Promise<void> => {
    if (bootPromiseRef.current) return bootPromiseRef.current;

    const boot = (async () => {
      const supabase = await getSupabase();

      const applySession = async (hasSession: boolean) => {
        if (!hasSession) {
          setProfile(null);
          setStatus('anonymous');
          return;
        }
        try {
          const p = await getMyProfile();
          setProfile(p);
          setStatus('signedIn');
        } catch (e) {
          setProfile(null);
          setStatus('signedIn');
          setError(e instanceof Error ? e.message : String(e));
        }
      };

      const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
          void applySession(Boolean(session));
        }
      });
      unsubRef.current = () => sub.subscription.unsubscribe();

      if (isOAuthCallback()) {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    })();

    bootPromiseRef.current = boot.catch((e) => {
      bootPromiseRef.current = null;
      throw e;
    });
    return bootPromiseRef.current;
  }, []);

  useEffect(() => {
    if (status === 'loading') {
      void bootSession().catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('anonymous');
      });
    }
  }, [status, bootSession]);

  useEffect(() => {
    if (status !== 'loading') return;
    const t = window.setTimeout(() => {
      setError('ログイン状態の確認がタイムアウトしました');
      setStatus('anonymous');
    }, 10_000);
    return () => window.clearTimeout(t);
  }, [status]);

  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
      bootPromiseRef.current = null;
    };
  }, []);

  const signInWithOAuthProvider = useCallback(
    async (provider: 'google' | 'apple') => {
      setError(null);
      try {
        setStatus('loading');
        const supabase = await getSupabase();
        await bootSession();
        const { error: e } = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo: window.location.origin },
        });
        if (e) throw new Error(e.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('anonymous');
      }
    },
    [bootSession],
  );

  const signInWithGoogle = useCallback(
    () => signInWithOAuthProvider('google'),
    [signInWithOAuthProvider],
  );

  const signInWithApple = useCallback(
    () => signInWithOAuthProvider('apple'),
    [signInWithOAuthProvider],
  );

  const signInWithEmailPassword = useCallback(
    async (email: string, password: string, mode: EmailAuthMode) => {
      setError(null);
      const trimmed = email.trim();
      if (!trimmed || !password) {
        setError('メールアドレスとパスワードを入力してください');
        return;
      }
      try {
        setStatus('loading');
        const supabase = await getSupabase();
        await bootSession();
        const origin = window.location.origin;
        if (mode === 'signup') {
          const { data, error: e } = await supabase.auth.signUp({
            email: trimmed,
            password,
            options: { emailRedirectTo: origin },
          });
          if (e) throw new Error(e.message);
          // Confirm Email ON のとき session は null。anonymous に戻して案内する。
          if (!data.session) {
            setStatus('anonymous');
            setError('確認メールを送信しました。メール内のリンクで認証してください');
            return;
          }
          // session あり（Confirm Email OFF 等）は onAuthStateChange が signedIn にする。
        } else {
          const { error: e } = await supabase.auth.signInWithPassword({
            email: trimmed,
            password,
          });
          if (e) throw new Error(e.message);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('anonymous');
      }
    },
    [bootSession],
  );

  const signInWithEmailOtp = useCallback(
    async (email: string): Promise<{ sent: true }> => {
      setError(null);
      const trimmed = email.trim();
      if (!trimmed) {
        setError('メールアドレスを入力してください');
        throw new Error('email required');
      }
      try {
        const supabase = await getSupabase();
        await bootSession();
        const { error: e } = await supabase.auth.signInWithOtp({
          email: trimmed,
          options: { emailRedirectTo: window.location.origin },
        });
        if (e) throw new Error(e.message);
        setError('マジックリンクを送信しました。メールを確認してください');
        return { sent: true };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [bootSession],
  );

  const signOut = useCallback(async () => {
    setError(null);
    try {
      const supabase = await getSupabase();
      await supabase.auth.signOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const submitInitialRating = useCallback(async (rating: number, source: RatingSource) => {
    setError(null);
    const p = await setInitialRating(rating, source);
    setProfile(p);
  }, []);

  const value: AuthState = enabled
    ? {
        status,
        profile,
        signInWithGoogle,
        signInWithApple,
        signInWithEmailPassword,
        signInWithEmailOtp,
        signOut,
        submitInitialRating,
        error,
      }
    : disabledState;

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
