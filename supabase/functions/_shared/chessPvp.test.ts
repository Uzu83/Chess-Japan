import { describe, expect, it } from 'vitest';
import { applySan, replayMoves, sansToPgn } from './chessPvp';

describe('replayMoves', () => {
  it('空列は初期局面', () => {
    const r = replayMoves([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn).toBe('white');
      expect(r.outcome.over).toBe(false);
      expect(r.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w')).toBe(true);
    }
  });

  it('合法な開手を通す', () => {
    const r = replayMoves(['e4', 'e5', 'Nf3']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sans).toEqual(['e4', 'e5', 'Nf3']);
      expect(r.turn).toBe('black');
    }
  });

  it('非法手を拒否', () => {
    expect(replayMoves(['e4', 'e5', 'e5']).ok).toBe(false);
    expect(replayMoves(['Qxh5']).ok).toBe(false);
  });

  it('空・過長 SAN を拒否', () => {
    expect(replayMoves(['']).ok).toBe(false);
    expect(replayMoves(['x'.repeat(20)]).ok).toBe(false);
  });
});

describe('applySan', () => {
  it('合法手を追加し終局を検出', () => {
    // Scholar's mate 風の短い詰み手順
    const moves = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];
    const before = moves.slice(0, -1);
    const r = applySan(before, 'Qxf7#');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome.over).toBe(true);
      if (r.outcome.over) {
        expect(r.outcome.reason).toBe('checkmate');
        expect(r.outcome.winner).toBe('white');
        expect(r.outcome.result).toBe('1-0');
      }
    }
  });

  it('終局後の着手を拒否', () => {
    const mate = applySan(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'], 'Qxf7#');
    expect(mate.ok).toBe(true);
    if (mate.ok) {
      const again = applySan(mate.sans, 'Ke7');
      expect(again.ok).toBe(false);
    }
  });

  it('手番違いの非法手を拒否', () => {
    expect(applySan(['e4'], 'e4').ok).toBe(false);
  });
});

describe('sansToPgn', () => {
  it('Result ヘッダ付き PGN を返す', () => {
    const pgn = sansToPgn(['e4', 'e5'], '1/2-1/2');
    expect(pgn).toContain('[Result "1/2-1/2"]');
    expect(pgn).toContain('1. e4 e5');
    expect(pgn).toContain('1/2-1/2');
  });
});
