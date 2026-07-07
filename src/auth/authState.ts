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

export interface AuthState {
  status: AuthStatus;
  profile: Profile | null;
  /** Google OAuth へリダイレクトする(戻ってくるまでこのページは離脱する)。 */
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  /** オンボーディングの確定。成功時は profile が更新される。 */
  submitInitialRating: (rating: number, source: RatingSource) => Promise<void>;
  /** 直近の auth 操作エラー(表示用)。 */
  error: string | null;
}

export const disabledState: AuthState = {
  status: 'disabled',
  profile: null,
  // disabled で呼ばれることは UI 上あり得ない(ボタンが出ない)が、型のため no-op を置く
  signInWithGoogle: async () => {},
  signOut: async () => {},
  submitInitialRating: async () => {},
  error: null,
};

export const AuthContext = createContext<AuthState>(disabledState);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
