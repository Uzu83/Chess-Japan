/*
 * authState.ts — 認証状態の型・コンテキスト・useAuth フック
 *
 * AuthContext.tsx(Provider コンポーネント)から分離している WHY:
 *   react-refresh/only-export-components — コンポーネントと非コンポーネント
 *   (hook・context・定数)を同居させると Fast Refresh が全リロードに落ちる。
 *   「コンポーネントは .tsx、状態定義は .ts」で分けるのがこのプロジェクトの形。
 */
import { createContext, useContext } from 'react';
import type { Profile, RatingSource } from './profile';

export type AuthStatus = 'disabled' | 'anonymous' | 'loading' | 'signedIn';

export type EmailAuthMode = 'signin' | 'signup';

export interface AuthState {
  status: AuthStatus;
  profile: Profile | null;
  /** Google OAuth へリダイレクトする(戻ってくるまでこのページは離脱する)。 */
  signInWithGoogle: () => Promise<void>;
  /** Apple OAuth へリダイレクト。 */
  signInWithApple: () => Promise<void>;
  /** メール+パスワード。signup は確認メール待ちの場合 signedIn にしない。 */
  signInWithEmailPassword: (email: string, password: string, mode: EmailAuthMode) => Promise<void>;
  /** マジックリンク / OTP メール送信。 */
  signInWithEmailOtp: (email: string) => Promise<{ sent: true }>;
  signOut: () => Promise<void>;
  /** オンボーディングの確定。成功時は profile が更新される。 */
  submitInitialRating: (rating: number, source: RatingSource) => Promise<void>;
  /** 直近の auth 操作エラー(表示用)。情報メッセージにも流用する場合あり。 */
  error: string | null;
}

export const disabledState: AuthState = {
  status: 'disabled',
  profile: null,
  // disabled で呼ばれることは UI 上あり得ない(ボタンが出ない)が、型のため no-op を置く
  signInWithGoogle: async () => {},
  signInWithApple: async () => {},
  signInWithEmailPassword: async () => {},
  signInWithEmailOtp: async () => ({ sent: true as const }),
  signOut: async () => {},
  submitInitialRating: async () => {},
  error: null,
};

export const AuthContext = createContext<AuthState>(disabledState);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
