/*
 * phase.ts — 序盤/中盤/終盤の決定論的判定（LLM 不使用）
 *
 * WHY 軽量自前パースか:
 *   tsshogi/chess.js に依存すると将棋ライブラリがメインチャンクへ漏れうる。
 *   FEN/SFEN の駒配置セグメントだけ数えれば十分なので文字列処理に閉じる。
 *
 * 規則（計画）:
 *   chess: ply≤20 → opening; クイーン両者0 or 残り駒≤6 → endgame; else middlegame
 *   shogi: ply≤30 → opening; 大駒(角飛+成)両者0 or 残り駒≤10 → endgame; else middlegame
 *   ply 閾値を先に見て opening、その後 endgame、残り middlegame。
 */
import type { GameKind } from './types';

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

/** チェス FEN の駒配置から枚数を数える（王以外の駒）。 */
function countChessPieces(fen: string): {
  total: number;
  whiteQueens: number;
  blackQueens: number;
} {
  const board = fen.trim().split(/\s+/)[0] ?? '';
  let total = 0;
  let whiteQueens = 0;
  let blackQueens = 0;
  for (const ch of board) {
    if (ch === '/' || (ch >= '1' && ch <= '8')) continue;
    if ('pnbrqkPNBRQK'.includes(ch)) {
      total += 1;
      if (ch === 'Q') whiteQueens += 1;
      if (ch === 'q') blackQueens += 1;
    }
  }
  // 王は常に2枚ある想定だが total に含まれる。残り駒判定は「盤上の全駒」でよい。
  return { total, whiteQueens, blackQueens };
}

/**
 * 将棋 SFEN の駒配置（先手大文字・後手小文字、成りは +X）。
 * 大駒 = 角飛馬龍（B R H D / b r h d）。残り駒は盤上の全駒。
 */
function countShogiPieces(sfen: string): {
  total: number;
  majorBothZero: boolean;
} {
  const board = sfen.trim().split(/\s+/)[0] ?? '';
  let total = 0;
  let majors = 0;
  let i = 0;
  while (i < board.length) {
    const ch = board[i]!;
    if (ch === '/') {
      i += 1;
      continue;
    }
    if (ch >= '1' && ch <= '9') {
      i += 1;
      continue;
    }
    if (ch === '+') {
      const next = board[i + 1];
      if (next && /[a-zA-Z]/.test(next)) {
        total += 1;
        if ('BRHDbrhd'.includes(next)) majors += 1;
        i += 2;
        continue;
      }
    }
    if (/[a-zA-Z]/.test(ch)) {
      total += 1;
      if ('BRHDbrhd'.includes(ch)) majors += 1;
    }
    i += 1;
  }
  return { total, majorBothZero: majors === 0 };
}

export function classifyPhase(params: {
  kind: GameKind;
  ply: number;
  fenOrSfen: string;
}): GamePhase {
  const { kind, ply, fenOrSfen } = params;
  if (kind === 'chess') {
    if (ply <= 20) return 'opening';
    const { total, whiteQueens, blackQueens } = countChessPieces(fenOrSfen);
    if ((whiteQueens === 0 && blackQueens === 0) || total <= 6) return 'endgame';
    return 'middlegame';
  }

  // shogi
  if (ply <= 30) return 'opening';
  const { total, majorBothZero } = countShogiPieces(fenOrSfen);
  if (majorBothZero || total <= 10) return 'endgame';
  return 'middlegame';
}

export function phaseLabelJa(phase: GamePhase): string {
  switch (phase) {
    case 'opening':
      return '序盤';
    case 'middlegame':
      return '中盤';
    case 'endgame':
      return '終盤';
  }
}
