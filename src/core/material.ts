/*
 * material.ts — マテリアル(駒得)計算の純関数
 *
 * WHY 必要か(ユーザー要望):
 *   対局中に「いま自分は駒得してるのか」を数字で確認したい。lichess/chess.com と同じく
 *   「取った駒の列 + 点差(+3 など)」をプレイヤープレートに出すための計算層。
 *   重要なのは総得点でなく“差”(自分 39点 vs 相手 36点 → +3 だけが意味を持つ)。
 *
 * 点数は標準的なマテリアル値(ユーザー指定と一致):
 *   ポーン=1, ナイト=3, ビショップ=3, ルーク=5, クイーン=9。キングは非売品なので 0(数えない)。
 *
 * WHY chess.js を使わず FEN を直接パースするか:
 *   盤面フィールド(FEN 第1フィールド)の文字を数えるだけで足り、Chess インスタンス生成
 *   (合法手計算などの初期化コスト)は不要。毎手・毎レンダーで呼んでもタダ同然に保つ。
 */

/** 点数を持つ駒(キング除く)。FEN の小文字表記に対応。 */
export type PieceLetter = 'p' | 'n' | 'b' | 'r' | 'q';

/** 駒種ごとのマテリアル点数。 */
export const PIECE_POINTS: Record<PieceLetter, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** 開始配置の駒数(片側)。取られた駒 = これ − 現在の盤上数。 */
const START_COUNTS: Record<PieceLetter, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/** 片側のマテリアル: 駒種ごとの盤上数と合計点。 */
export interface SideMaterial {
  counts: Record<PieceLetter, number>;
  points: number;
}

/** FEN から両者のマテリアルを数える。 */
export function materialFromFen(fen: string): { white: SideMaterial; black: SideMaterial } {
  // FEN 第1フィールド = 盤面。それ以外(手番/キャスリング権/…)は不要。
  const board = fen.split(' ')[0] ?? '';
  const make = (): SideMaterial => ({ counts: { p: 0, n: 0, b: 0, r: 0, q: 0 }, points: 0 });
  const white = make();
  const black = make();

  for (const ch of board) {
    const lower = ch.toLowerCase() as PieceLetter;
    if (!(lower in PIECE_POINTS)) continue; // k/K・数字・'/' はスキップ
    // FEN は 大文字=白, 小文字=黒
    const side = ch === lower ? black : white;
    side.counts[lower]++;
    side.points += PIECE_POINTS[lower];
  }
  return { white, black };
}

/**
 * 「この側が失った駒」= 開始配置 − 現在の盤上数。
 * 相手プレートには「相手が取った駒」としてこの結果を表示する。
 *
 * WHY Math.max(0, …) で丸めるか:
 *   プロモーションでクイーンが2枚になると 1 − 2 = -1 になる。「-1個取られた」は表示として
 *   無意味なので 0 に丸める(点差の方は盤上の実マテリアルから計算するため昇格も正しく反映される)。
 */
export function lostPieces(counts: Record<PieceLetter, number>): Record<PieceLetter, number> {
  const out = {} as Record<PieceLetter, number>;
  for (const k of Object.keys(START_COUNTS) as PieceLetter[]) {
    out[k] = Math.max(0, START_COUNTS[k] - counts[k]);
  }
  return out;
}
