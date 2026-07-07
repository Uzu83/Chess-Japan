/*
 * AuthContext.tsx — 認証状態の React コンテキスト
 *
 * 状態マシン(4値):
 *   'disabled'  … VITE_AUTH_ENABLED != '1' 等で auth 機能ごと無効。UI は一切出ない。
 *                 既存のオフラインテスト・フォーク・ローカル dev はここに落ちる
 *                 (= App の描画が従来と完全に同一、が必須要件)。
 *   'anonymous' … auth は有効だが未ログイン。SDK はロードしない(バンドル戦略)。
 *   'loading'   … セッション復元 or OAuth コールバック処理中。
 *   'signedIn'  … ログイン済み。profile を保持。
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
import type { AuthState, AuthStatus } from './authState';

export function AuthProvider({ children }: { children: ReactNode }) {
  // enabled はマウント時に1回だけ判定(env はビルド時定数なので変わらない)。
  const enabled = isAuthConfigured();

  const [status, setStatus] = useState<AuthStatus>(() => {
    if (!enabled) return 'disabled';
    // セッション持ち or OAuth 帰着なら復元処理(loading)へ。それ以外は SDK 非ロード。
    return hasStoredSession() || isOAuthCallback() ? 'loading' : 'anonymous';
  });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // onAuthStateChange の購読解除用。
  const unsubRef = useRef<(() => void) | null>(null);

  /** SDK を起動してセッション監視を張り、現在のセッションから profile を読む。 */
  const bootSession = useCallback(async () => {
    const supabase = await getSupabase();

    // OAuth 帰着時: detectSessionInUrl がコード交換を終えるのを onAuthStateChange で
    // 待つ。getSession() を先に読むだけだと交換完了前に null を掴むことがある。
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
        // profile 取得失敗(ネットワーク等)でもログイン自体は成立している。
        // profile=null の signedIn とし、オンボーディング側の自己修復に任せる。
        setProfile(null);
        setStatus('signedIn');
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // INITIAL_SESSION: 復元完了(セッション有無どちらも来る)
      // SIGNED_IN / SIGNED_OUT: 明示的な状態遷移
      // TOKEN_REFRESHED 等では profile を読み直さない(無駄な往復を避ける)
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        void applySession(Boolean(session));
      }
    });
    unsubRef.current = () => sub.subscription.unsubscribe();

    // OAuth 帰着後は URL の ?code= を消してリロード再交換・共有事故を防ぐ。
    if (isOAuthCallback()) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (status === 'loading' && !unsubRef.current) {
      void bootSession().catch((e) => {
        // SDK ロード自体の失敗(オフライン等)。匿名として続行 = 本体機能は無傷。
        setError(e instanceof Error ? e.message : String(e));
        setStatus('anonymous');
      });
    }
    return () => {
      // アンマウント時のみ購読解除(App 直下なので実質セッション終了時)。
    };
  }, [status, bootSession]);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    try {
      setStatus('loading');
      const supabase = await getSupabase();
      if (!unsubRef.current) await bootSession();
      const { error: e } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // 戻り先は現在のオリジン(本番/preview/localhost すべて Supabase 側の
        // Redirect URLs 許可リストに載せる必要がある — .env.example の運用メモ参照)。
        options: { redirectTo: window.location.origin },
      });
      if (e) throw new Error(e.message);
      // 成功時はフルページ遷移するのでここには戻らない。
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('anonymous');
    }
  }, [bootSession]);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      const supabase = await getSupabase();
      await supabase.auth.signOut();
      // onAuthStateChange(SIGNED_OUT) が anonymous へ落とす。
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
    ? { status, profile, signInWithGoogle, signOut, submitInitialRating, error }
    : disabledState;

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
