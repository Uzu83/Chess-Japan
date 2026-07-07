import { describe, it, expect } from 'vitest';
import { materialFromFen, lostPieces, PIECE_POINTS } from './material';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('materialFromFen', () => {
  it('初期局面は両者 39 点(8+6+6+10+9)で対等', () => {
    const m = materialFromFen(START);
    expect(m.white.points).toBe(39);
    expect(m.black.points).toBe(39);
    expect(m.white.counts).toEqual({ p: 8, n: 2, b: 2, r: 2, q: 1 });
  });

  it('駒が減ると点数に反映される(黒クイーンなし = 黒 30 点)', () => {
    const fen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const m = materialFromFen(fen);
    expect(m.black.points).toBe(30);
    expect(m.white.points - m.black.points).toBe(9); // 白 +9
  });

  it('キングは点数に数えない', () => {
    const fen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const m = materialFromFen(fen);
    expect(m.white.points).toBe(0);
    expect(m.black.points).toBe(0);
  });

  it('プロモーション(白クイーン2枚)は盤上実数で数える', () => {
    const fen = 'Q3k3/8/8/8/8/8/8/Q3K3 w - - 0 1';
    const m = materialFromFen(fen);
    expect(m.white.counts.q).toBe(2);
    expect(m.white.points).toBe(18);
  });

  it('PIECE_POINTS はユーザー指定の標準値', () => {
    expect(PIECE_POINTS).toEqual({ p: 1, n: 3, b: 3, r: 5, q: 9 });
  });
});

describe('lostPieces', () => {
  it('初期配置では失った駒なし', () => {
    const m = materialFromFen(START);
    expect(lostPieces(m.white.counts)).toEqual({ p: 0, n: 0, b: 0, r: 0, q: 0 });
  });

  it('失った駒 = 開始配置との差', () => {
    // 黒: ポーン6・ナイト1・クイーン0
    const fen = 'rnb1kb1r/pppppp2/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const m = materialFromFen(fen);
    expect(lostPieces(m.black.counts)).toEqual({ p: 2, n: 1, b: 0, r: 0, q: 1 });
  });

  it('プロモーションで開始数を超えても負にならない(0 に丸め)', () => {
    const fen = 'QQ2k3/8/8/8/8/8/8/4K3 w - - 0 1'; // 白クイーン2枚
    const m = materialFromFen(fen);
    expect(lostPieces(m.white.counts).q).toBe(0);
  });
});
