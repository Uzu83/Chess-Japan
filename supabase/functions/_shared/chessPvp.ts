/*
 * chessPvp.ts — PvP 着手検証の純ロジック（Deno Edge + vitest 共用）
 *
 * WHY SQL に置かないか: Postgres に chess.js が無く、棋理検証を PL/pgSQL で書くのは
 * バグリスクが大きい。Edge が検証し、service_role 専用 RPC が原子的に書き込む。
 *
 * 終局判定順は src/core/playGame.ts の outcome() に合わせる
 * （詰み → ステイル → 戦力不足 → 千日手 → 50手）。
 */
import { Chess } from 'chess.js';

export type PvpColor = 'white' | 'black';

export type PvpOutcome =
  | { over: false }
  | {
      over: true;
      reason: 'checkmate' | 'stalemate' | 'insufficient' | 'threefold' | 'fiftyMove';
      winner: PvpColor | null;
      result: '1-0' | '0-1' | '1/2-1/2';
    };

export interface ReplayOk {
  ok: true;
  fen: string;
  sans: string[];
  turn: PvpColor;
  outcome: PvpOutcome;
}

export interface ReplayErr {
  ok: false;
  error: string;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function turnOf(chess: Chess): PvpColor {
  return chess.turn() === 'w' ? 'white' : 'black';
}

function outcomeOf(chess: Chess): PvpOutcome {
  if (chess.isCheckmate()) {
    const loser = turnOf(chess);
    const winner: PvpColor = loser === 'white' ? 'black' : 'white';
    return {
      over: true,
      reason: 'checkmate',
      winner,
      result: winner === 'white' ? '1-0' : '0-1',
    };
  }
  if (chess.isStalemate()) {
    return { over: true, reason: 'stalemate', winner: null, result: '1/2-1/2' };
  }
  if (chess.isInsufficientMaterial()) {
    return { over: true, reason: 'insufficient', winner: null, result: '1/2-1/2' };
  }
  if (chess.isThreefoldRepetition()) {
    return { over: true, reason: 'threefold', winner: null, result: '1/2-1/2' };
  }
  if (chess.isDraw()) {
    return { over: true, reason: 'fiftyMove', winner: null, result: '1/2-1/2' };
  }
  return { over: false };
}

/** 既存 SAN 列を再生。非法手があればそこで失敗。 */
export function replayMoves(sans: string[]): ReplayOk | ReplayErr {
  const chess = new Chess(START_FEN);
  const normalized: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    const raw = sans[i];
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > 16) {
      return { ok: false, error: `invalid san at ${i}` };
    }
    try {
      const moved = chess.move(raw);
      if (!moved) return { ok: false, error: `illegal san at ${i}` };
      normalized.push(moved.san);
    } catch {
      return { ok: false, error: `illegal san at ${i}` };
    }
  }
  return {
    ok: true,
    fen: chess.fen(),
    sans: normalized,
    turn: turnOf(chess),
    outcome: outcomeOf(chess),
  };
}

/**
 * 既存局面に 1 手追加して検証。
 * 戻り値の sans は正規化 SAN を末尾に付けた全列。
 */
export function applySan(existingSans: string[], san: string): ReplayOk | ReplayErr {
  if (typeof san !== 'string' || san.length < 2 || san.length > 16) {
    return { ok: false, error: 'invalid san' };
  }
  const base = replayMoves(existingSans);
  if (!base.ok) return base;
  if (base.outcome.over) return { ok: false, error: 'game already over' };
  if (existingSans.length >= 500) return { ok: false, error: 'too many moves' };

  const chess = new Chess(base.fen);
  try {
    const moved = chess.move(san);
    if (!moved) return { ok: false, error: 'illegal move' };
    const sans = [...base.sans, moved.san];
    return {
      ok: true,
      fen: chess.fen(),
      sans,
      turn: turnOf(chess),
      outcome: outcomeOf(chess),
    };
  } catch {
    return { ok: false, error: 'illegal move' };
  }
}

/** SAN 配列から最小 PGN（Result 付き）を組み立てる。 */
export function sansToPgn(sans: string[], result: string): string {
  const parts: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) parts.push(`${Math.floor(i / 2) + 1}.`);
    parts.push(sans[i]!);
  }
  const body = parts.join(' ').trim();
  return `[Result "${result}"]\n\n${body}${body ? ' ' : ''}${result}\n`;
}
