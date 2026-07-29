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
  /** マジックリンク / OTP メール送信（パスワード無しログイン）。 */
  signInWithEmailOtp: (email: string) => Promise<{ sent: true }>;
  /** パスワード再設定メール（リンク後に updatePassword）。 */
  resetPassword: (email: string) => Promise<{ sent: true }>;
  /** recovery セッション後の新パスワード設定。 */
  updatePassword: (password: string) => Promise<void>;
  /** パスワード再設定 UI を出すか（PASSWORD_RECOVERY）。 */
  passwordRecoveryPending: boolean;
  clearPasswordRecovery: () => void;
  signOut: () => Promise<void>;
  /** オンボーディングの確定。成功時は profile が更新される。 */
  submitInitialRating: (rating: number, source: RatingSource) => Promise<void>;
  /**
   * profiles を再取得（Checkout 戻りで webhook 反映を拾う等）。
   * signedIn 以外では no-op。失敗時は error に載せる。
   */
  refreshProfile: () => Promise<void>;
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
  resetPassword: async () => ({ sent: true as const }),
  updatePassword: async () => {},
  passwordRecoveryPending: false,
  clearPasswordRecovery: () => {},
  signOut: async () => {},
  submitInitialRating: async () => {},
  refreshProfile: async () => {},
  error: null,
};

export const AuthContext = createContext<AuthState>(disabledState);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
