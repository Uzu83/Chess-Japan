/*
 * playstyle.ts — ルールベースの戦術タグ付け(得意/苦手分析の素材)の純関数
 *
 * WHY ルールベースか(LLM不使用):
 *   タグは strengthAggregator.ts が頻度/成功率で集計する「機械的な特徴」であり、
 *   LLM の主観的判定を挟むと集計結果が再現不能になる。座標(UCI/USI)と評価値の
 *   数値事実だけで決定論的に付ける。
 *
 * WHY chess.js / tsshogi に依存しないか:
 *   ここで必要なのは「移動先マスに駒があるか」程度の軽量な盤面参照のみ。合法手計算は
 *   不要なので、material.ts / phase.ts と同様に FEN/SFEN の駒配置フィールドを自前で
 *   直接読む(将棋一式をメインバンドルに漏らさない1バイト不変条件と整合)。
 *
 * 過剰タグ付けを避ける方針(仕様どおり 0〜3個程度):
 *   各ヒューリスティックは互いに排他的になるよう閾値を分けている(例: sacrifice は
 *   評価スイングが「大きい」、exchange は「小さい」)。それでも理論上重なるケースに
 *   備え、最後に MAX_TAGS で安全側に切る。
 */

import type { GameKind, MoveQuality } from './types';
import type { GamePhase } from './phase';

export type PlaystyleTag =
  | 'castle'
  | 'exchange'
  | 'sacrifice'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'pawn_break'
  | 'endgame_technique'
  | 'drop'
  | 'promotion'
  | 'fork_like'
  | 'entering_king'
  | 'defense';

/** 1手あたりに付けるタグ数の上限(過剰タグ付け防止の安全弁)。 */
const MAX_TAGS = 3;

/** チェスのキャスリングを表す UCI 4種(白/黒 × キングサイド/クイーンサイド)。 */
const CASTLE_UCI = new Set(['e1g1', 'e1c1', 'e8g8', 'e8c8']);

/**
 * 「大きい評価スイング + best/good」を sacrifice 候補とみなす閾値(cp)。
 * WHY 素朴に「差が大きい」を使うか: 実際の駒損失を検出するには盤面差分が必要で
 * 過剰実装になる。仕様どおり評価値の振れ幅だけで簡易判定する(セルフドキュメント
 * のためコメントに明記: これは厳密な「捨て駒」検出ではなくヒント)。
 */
const SACRIFICE_SWING_CP = 150;

/** 「ほぼ変わらない」とみなす評価スイング(cp)の上限。exchange 判定に使う。 */
const EXCHANGE_SWING_CP = 20;

function isGoodQuality(quality: MoveQuality): boolean {
  return quality === 'best' || quality === 'good';
}

/** FEN/SFEN の駒配置フィールドだけを取り出す。 */
function boardFieldOf(fenOrSfen: string): string {
  return fenOrSfen.split(' ')[0] ?? '';
}

/** チェス FEN 上で、指定の algebraic マス(例 "e4")に駒があるか。 */
function chessSquareOccupied(fen: string, square: string): boolean {
  const ranks = boardFieldOf(fen).split('/'); // ranks[0]=8段目 ... ranks[7]=1段目
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7 (a-h)
  const rank = Number(square[1]); // 1-8
  if (Number.isNaN(rank) || file < 0 || file > 7) return false;
  const rankStr = ranks[8 - rank] ?? '';
  let col = 0;
  for (const ch of rankStr) {
    if (ch >= '1' && ch <= '8') {
      col += Number(ch);
      continue;
    }
    if (col === file) return true;
    col++;
  }
  return false;
}

/** 将棋 SFEN 上で、指定の USI マス(例 "5e")に駒があるか。 */
function shogiSquareOccupied(sfen: string, square: string): boolean {
  const file = Number(square[0]); // 1-9
  const rankLetter = square[1];
  if (!file || !rankLetter) return false;
  const rankIdx = rankLetter.charCodeAt(0) - 'a'.charCodeAt(0); // a=0段目 ... i=8段目
  const rankStr = boardFieldOf(sfen).split('/')[rankIdx] ?? '';
  const targetCol = 9 - file; // 盤面文字列は9筋始まり(col0=9筋 ... col8=1筋)
  let col = 0;
  let i = 0;
  while (i < rankStr.length) {
    const ch = rankStr[i];
    if (ch >= '0' && ch <= '9') {
      col += Number(ch);
      i++;
      continue;
    }
    const consumed = ch === '+' ? 2 : 1; // 成駒は "+" + 駒文字で1マス
    if (col === targetCol) return true;
    col++;
    i += consumed;
  }
  return false;
}

/** UCI/USI の移動先マスを取り出す(打つ手・成る手も対応)。取れなければ null。 */
function toSquareOf(kind: GameKind, movePlayed: string): string | null {
  if (kind === 'chess') {
    return movePlayed.length >= 4 ? movePlayed.slice(2, 4) : null;
  }
  const dropIdx = movePlayed.indexOf('*');
  if (dropIdx >= 0) return movePlayed.slice(dropIdx + 1, dropIdx + 3);
  return movePlayed.length >= 4 ? movePlayed.slice(2, 4) : null;
}

/**
 * 「取ったっぽい手」の簡易判定(exchange 用)。指す前の局面の移動先マスに駒があれば
 * capture 相当とみなす(アンパッサンのように移動先が空のケースは検出しない=既知の簡易化)。
 */
function looksLikeCapture(
  kind: GameKind,
  fenOrSfen: string | undefined,
  movePlayed: string | undefined,
): boolean {
  if (!fenOrSfen || !movePlayed) return false;
  const to = toSquareOf(kind, movePlayed);
  if (!to) return false;
  return kind === 'chess' ? chessSquareOccupied(fenOrSfen, to) : shogiSquareOccupied(fenOrSfen, to);
}

/**
 * 1手にルールベースの戦術タグを付ける。
 *
 * @param evalBefore/evalAfter 手番側視点センチポーン(classify.ts の buildExplanationContext 参照)。
 * @param movePlayed UCI(チェス)または USI(将棋)。
 * @param fenOrSfen  指す前の局面(exchange 判定にのみ使用)。
 */
export function tagMove(params: {
  kind: GameKind;
  phase: GamePhase;
  quality: MoveQuality;
  evalBefore?: number;
  evalAfter?: number;
  movePlayed?: string;
  fenOrSfen?: string;
}): PlaystyleTag[] {
  const { kind, phase, quality, evalBefore, evalAfter, movePlayed, fenOrSfen } = params;
  const tags: PlaystyleTag[] = [];
  const good = isGoodQuality(quality);

  if (kind === 'chess' && movePlayed && CASTLE_UCI.has(movePlayed)) {
    tags.push('castle');
  }

  if (kind === 'shogi' && movePlayed?.includes('*')) {
    tags.push('drop');
  }

  if (kind === 'shogi' && movePlayed?.endsWith('+')) {
    tags.push('promotion');
  }

  const hasEval = evalBefore !== undefined && evalAfter !== undefined;
  const swing = hasEval ? Math.abs(evalAfter! - evalBefore!) : undefined;

  if (kind === 'chess' && swing !== undefined && swing >= SACRIFICE_SWING_CP && good) {
    tags.push('sacrifice');
  }

  if (
    swing !== undefined &&
    swing <= EXCHANGE_SWING_CP &&
    looksLikeCapture(kind, fenOrSfen, movePlayed)
  ) {
    tags.push('exchange');
  }

  if (phase === 'endgame' && good) {
    tags.push('endgame_technique');
  }

  return tags.slice(0, MAX_TAGS);
}
