import { ChessGame } from './game';

// スコッチ・ゲームの短い手順
const PGN = `1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 *`;

describe('ChessGame.fromPgn', () => {
  it('PGN を手のリストに変換する', () => {
    const game = ChessGame.fromPgn(PGN);
    expect(game.length).toBe(7);
    expect(game.moves[0].san).toBe('e4');
    expect(game.moves[0].uci).toBe('e2e4');
    expect(game.moves[0].color).toBe('w');
  });

  it('各手の前後FENが連続する', () => {
    const game = ChessGame.fromPgn(PGN);
    for (let i = 1; i < game.length; i++) {
      expect(game.moves[i].fenBefore).toBe(game.moves[i - 1].fenAfter);
    }
  });

  it('fenAt(0) は開始局面、fenAt(k) はk手目直後', () => {
    const game = ChessGame.fromPgn(PGN);
    expect(game.fenAt(0)).toBe(game.startFen);
    expect(game.fenAt(1)).toBe(game.moves[0].fenAfter);
    expect(game.fenAt(game.length)).toBe(game.moves[game.length - 1].fenAfter);
    // 範囲外はクランプ
    expect(game.fenAt(999)).toBe(game.moves[game.length - 1].fenAfter);
  });

  it('不正な PGN は例外を投げる', () => {
    expect(() => ChessGame.fromPgn('1. e9 z9')).toThrow();
  });
});
