/*
 * rating.ts — Elo レーティング計算の純関数
 *
 * WHY 今つくるか(2026-07-07 オーナー GO):
 *   Phase A の AI 戦に「あなたのレート」を導入する(ローカル版内部レート)。
 *   アカウント(Phase 2C)を待たずに localStorage でレート体験を先に出し、
 *   2C でクラウド同期(profiles.rating)に“昇格”させる。この計算層はそのとき
 *   サーバー側(Edge Function / DB trigger)へ移植される前提で、副作用ゼロの純関数に保つ。
 *
 * 数式は標準 Elo:
 *   期待勝率 E = 1 / (1 + 10^((相手R - 自分R) / 400))
 *   新レート  R' = R + K * (実際のスコア - E)      スコア: 勝ち=1, 引分=0.5, 負け=0
 *
 * K=32 の根拠:
 *   歴史的な標準値で、対局数の少ないカジュアル層の変動が体感できる速さ(±16前後/局)。
 *   lichess 等は Glicko-2 を使うが、1人×AI戦のローカルレートに信頼度パラメータは過剰。
 *   Phase 2C の対人戦で精度が問題になったら Glicko-2 への置換を検討(この層だけ差し替え)。
 */

/** 新規プレイヤーの初期レート。チェスサイト慣行の中央値(lichess=1500, chess.com=800〜1200)の中庸。 */
export const INITIAL_RATING = 1200;

/** K係数(1局あたりの最大変動幅)。 */
export const K_FACTOR = 32;

/** レートの下限。連敗しても 0 やマイナスに沈まない安全弁(モチベーション保護も兼ねる)。 */
export const RATING_FLOOR = 100;

/** 対局結果のスコア表現。勝ち=1 / 引分=0.5 / 負け=0(Elo 数式の入力)。 */
export type GameScore = 1 | 0.5 | 0;

/** 期待勝率 E を返す(0..1)。自分と相手のレート差から算出。 */
export function expectedScore(myRating: number, oppRating: number): number {
  return 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
}

/**
 * 1局の結果からレート変動(delta)を返す。四捨五入した整数。
 * 呼び出し側は newRating = max(RATING_FLOOR, rating + delta) を適用する(applyResult を使うと楽)。
 */
export function ratingDelta(myRating: number, oppRating: number, score: GameScore): number {
  return Math.round(K_FACTOR * (score - expectedScore(myRating, oppRating)));
}

/** 1局の結果を適用した新レートと変動を返す。下限 RATING_FLOOR でクランプ。 */
export function applyResult(
  myRating: number,
  oppRating: number,
  score: GameScore,
): { rating: number; delta: number } {
  const delta = ratingDelta(myRating, oppRating, score);
  const rating = Math.max(RATING_FLOOR, myRating + delta);
  // クランプが効いた場合、実際の変動は (rating - myRating) になる(表示のズレ防止)
  return { rating, delta: rating - myRating };
}
