/*
 * publicStrength.ts — 公開プロフィール仕様（F007）のクライアント契約
 *
 * get_public_strength RPC が返す固定形。user_id / 棋譜 / 相手は含まれない。
 */
export interface PublicStrengthDto {
  handle: string;
  /** 粗い精度バケット。未検証詳細は 'unverified-private-detail' */
  accuracy_bucket: string;
  top_strengths: string[];
  top_weaknesses: string[];
  /** '20-49' | '50-99' | '100+' */
  games_bucket: string;
}

/** 公開に必要な最小局数（migration 0006 と一致）。 */
export const PUBLIC_STRENGTH_MIN_GAMES = 20;
