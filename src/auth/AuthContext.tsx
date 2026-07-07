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
  // boot の一度きり実行を保証する Promise 保持。
  // WHY unsubRef の有無で判定しないか(監査ワークフロー指摘): boot は async なので
  // 「開始済みだが unsubRef 未設定」の窓があり、signInWithGoogle と effect が同時に
  // 走ると購読が二重に張られる。Promise を握れば2回目以降は同じ boot を待つだけ。
  const bootPromiseRef = useRef<Promise<void> | null>(null);

  /** SDK を起動してセッション監視を張り、現在のセッションから profile を読む(冪等)。 */
  const bootSession = useCallback((): Promise<void> => {
    if (bootPromiseRef.current) return bootPromiseRef.current;

    const boot = (async () => {
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

      // OAuth 帰着後は code/state だけを URL から消す(リロード再交換・共有事故防止)。
      // WHY 全 query を落とさないか(Codex ゲート②指摘): 将来 ?fen= 等の正当な
      // パラメータが付いたとき巻き添えで消してしまうため、PKCE 由来の2つに限定。
      if (isOAuthCallback()) {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    })();

    // 失敗したら次回リトライできるように捨てる(冪等ガードを恒久エラー化しない)。
    bootPromiseRef.current = boot.catch((e) => {
      bootPromiseRef.current = null;
      throw e;
    });
    return bootPromiseRef.current;
  }, []);

  useEffect(() => {
    if (status === 'loading') {
      void bootSession().catch((e) => {
        // SDK ロード自体の失敗(オフライン等)。匿名として続行 = 本体機能は無傷。
        setError(e instanceof Error ? e.message : String(e));
        setStatus('anonymous');
      });
    }
  }, [status, bootSession]);

  // loading 永続化の watchdog(監査ワークフロー指摘): PKCE コード交換がネットワークで
  // ハングすると INITIAL_SESSION が来ず loading のまま固まりうる。10 秒で匿名に落とし、
  // 本体機能(対局・レビュー)を人質に取らない。10 秒の根拠: OAuth 往復直後の交換 API
  // 1 リクエスト分として十分長く、ユーザーが「壊れた」と感じる前に解放できる長さ。
  useEffect(() => {
    if (status !== 'loading') return;
    const t = window.setTimeout(() => {
      setError('ログイン状態の確認がタイムアウトしました');
      setStatus('anonymous');
    }, 10_000);
    return () => window.clearTimeout(t);
  }, [status]);

  // アンマウント時に購読解除(StrictMode の mount→unmount→mount で漏れない)。
  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
      bootPromiseRef.current = null;
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    try {
      setStatus('loading');
      const supabase = await getSupabase();
      await bootSession(); // 冪等(既に boot 済みなら同じ Promise を待つだけ)
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
