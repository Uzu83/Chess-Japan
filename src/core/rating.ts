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

/**
 * レートの上限。
 *
 * WHY 3000 か:
 *   サーバー側 supabase/migrations/0004_*.sql の profiles テーブルに
 *   `check (rating between 100 and 3000)` 制約を入れた。フロントとサーバーで
 *   上限を揃えないと、フロントが 3001 を計算してクラウド同期時に check violation が起きる。
 *   フロント側にも同じ天井を設け「どちらが先にはじく」かを問わずパリティを保つ。
 *
 * 3000 の根拠:
 *   人間の歴代最高 FIDE レートは Magnus Carlsen の 2882(2014)。
 *   AIの最高難度目安は 2800 台(FIDE 9段・SF レベル相当)。
 *   3000 は「到達し得ない天井」であり、実用上クランプが効くケースはほぼ存在しない。
 *   もし将来 AI が 3000 超を目指すコースに変わるなら、このファイルと
 *   migration の check 制約を同時に変更すること(片方だけ変えると不整合)。
 */
export const RATING_CEILING = 3000;

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

/**
 * 1局の結果を適用した新レートと変動を返す。[RATING_FLOOR, RATING_CEILING] でクランプ。
 *
 * クランプ時の delta 補正について:
 *   数式上の delta(例: +8)を適用すると天井/床を超えることがある。
 *   その場合 delta を「実際の変化量 = rating - myRating」に補正して返す。
 *   これにより UI が「+8上がった」と表示してしまうズレを防ぐ。
 *   例: 2998 で勝利 → 数式 +8 → 3006 → 天井で 3000 → delta=+2 を返す。
 *
 * WHY ceil と floor の両方をここで処理するか:
 *   呼び出し側に「Math.min(CEILING, Math.max(FLOOR, ...))」を散らすとクランプ漏れのリスクがある。
 *   ここで一元管理することで、どこから呼んでも不変条件 FLOOR ≤ rating ≤ CEILING が成り立つ。
 */
export function applyResult(
  myRating: number,
  oppRating: number,
  score: GameScore,
): { rating: number; delta: number } {
  const delta = ratingDelta(myRating, oppRating, score);
  // [RATING_FLOOR, RATING_CEILING] の両方でクランプ。
  // サーバー側 profiles.rating の check 制約と同じ範囲にする義務がある。
  const rating = Math.min(RATING_CEILING, Math.max(RATING_FLOOR, myRating + delta));
  // クランプが効いた場合、実際の変動は (rating - myRating) になる(表示のズレ防止)
  return { rating, delta: rating - myRating };
}
