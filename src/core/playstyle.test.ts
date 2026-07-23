import { tagMove } from './playstyle';

const CHESS_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// e4 に黒ポーンが立っている局面(白 Nc3xe4 のような「取ったっぽい」手の検証用)。
const CHESS_CAPTURE_SETUP = 'rnbqkbnr/pppp1ppp/8/8/4p3/2N5/PPPP1PPP/R1BQKB1R w KQkq - 0 4';

// 5e に後手の歩が立っている局面(先手が取ったっぽい手の検証用)。
const SHOGI_CAPTURE_SETUP = '4k4/9/9/9/4p4/9/9/9/4K4 b - 1';

describe('tagMove — castle (chess)', () => {
  it('e1g1/e1c1/e8g8/e8c8 は castle', () => {
    for (const uci of ['e1g1', 'e1c1', 'e8g8', 'e8c8']) {
      const tags = tagMove({ kind: 'chess', phase: 'opening', quality: 'best', movePlayed: uci });
      expect(tags).toContain('castle');
    }
  });

  it('キャスリング以外の手には castle を付けない', () => {
    const tags = tagMove({ kind: 'chess', phase: 'opening', quality: 'best', movePlayed: 'e2e4' });
    expect(tags).not.toContain('castle');
  });

  it('将棋では castle を付けない(USI がたまたま同じ文字列でも kind で分岐)', () => {
    const tags = tagMove({ kind: 'shogi', phase: 'opening', quality: 'best', movePlayed: 'e1g1' });
    expect(tags).not.toContain('castle');
  });
});

describe('tagMove — drop / promotion (shogi)', () => {
  it('"*" を含む USI(打つ手) は drop', () => {
    const tags = tagMove({
      kind: 'shogi',
      phase: 'middlegame',
      quality: 'good',
      movePlayed: 'P*5e',
    });
    expect(tags).toContain('drop');
  });

  it('末尾 "+" の USI(成る手) は promotion', () => {
    const tags = tagMove({
      kind: 'shogi',
      phase: 'middlegame',
      quality: 'good',
      movePlayed: '7g7f+',
    });
    expect(tags).toContain('promotion');
  });

  it('打つ手でも成る手でもない USI には付けない', () => {
    const tags = tagMove({
      kind: 'shogi',
      phase: 'middlegame',
      quality: 'good',
      movePlayed: '7g7f',
    });
    expect(tags).not.toContain('drop');
    expect(tags).not.toContain('promotion');
  });

  it('チェスでは drop/promotion を付けない(UCI に "*"/"+" は出現しないが kind でも独立に保証)', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'good',
      movePlayed: 'e7e8',
    });
    expect(tags).not.toContain('drop');
    expect(tags).not.toContain('promotion');
  });
});

describe('tagMove — sacrifice (chess)', () => {
  it('評価スイングが大きく quality が best/good なら sacrifice', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 20,
      evalAfter: 200,
      movePlayed: 'd1h5',
    });
    expect(tags).toContain('sacrifice');
  });

  it('評価スイングが大きくても quality が mistake/blunder なら sacrifice にしない', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'blunder',
      evalBefore: 20,
      evalAfter: 300,
      movePlayed: 'd1h5',
    });
    expect(tags).not.toContain('sacrifice');
  });

  it('評価スイングが小さいなら sacrifice にしない', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 20,
      evalAfter: 25,
      movePlayed: 'd1h5',
    });
    expect(tags).not.toContain('sacrifice');
  });

  it('将棋では sacrifice を付けない(仕様上チェス限定)', () => {
    const tags = tagMove({
      kind: 'shogi',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 20,
      evalAfter: 300,
      movePlayed: '7g7f',
    });
    expect(tags).not.toContain('sacrifice');
  });
});

describe('tagMove — exchange', () => {
  it('評価がほぼ変わらず「取ったっぽい」手(移動先に駒がある)なら exchange(chess)', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 10,
      evalAfter: 5,
      movePlayed: 'c3e4', // Nxe4 相当。e4 に黒ポーンあり(CHESS_CAPTURE_SETUP)
      fenOrSfen: CHESS_CAPTURE_SETUP,
    });
    expect(tags).toContain('exchange');
  });

  it('移動先に駒が無ければ exchange を付けない(単なる駒の前進)', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'opening',
      quality: 'good',
      evalBefore: 10,
      evalAfter: 5,
      movePlayed: 'e2e4', // e4 は空(CHESS_START)
      fenOrSfen: CHESS_START,
    });
    expect(tags).not.toContain('exchange');
  });

  it('評価スイングが大きければ「取ったっぽい」手でも exchange を付けない', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 10,
      evalAfter: 200,
      movePlayed: 'c3e4',
      fenOrSfen: CHESS_CAPTURE_SETUP,
    });
    expect(tags).not.toContain('exchange');
  });

  it('将棋でも同様に判定できる(移動先に駒があり評価がほぼ変わらない)', () => {
    const tags = tagMove({
      kind: 'shogi',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 10,
      evalAfter: 15,
      movePlayed: '5f5e', // 5e に後手歩あり(SHOGI_CAPTURE_SETUP)
      fenOrSfen: SHOGI_CAPTURE_SETUP,
    });
    expect(tags).toContain('exchange');
  });

  it('fenOrSfen 未指定なら exchange は判定しない(安全側)', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'middlegame',
      quality: 'good',
      evalBefore: 10,
      evalAfter: 12,
      movePlayed: 'c3e4',
    });
    expect(tags).not.toContain('exchange');
  });
});

describe('tagMove — endgame_technique', () => {
  it('phase===endgame かつ quality が best/good なら付く', () => {
    const tags = tagMove({ kind: 'chess', phase: 'endgame', quality: 'best' });
    expect(tags).toContain('endgame_technique');
  });

  it('phase===endgame でも quality が mistake/blunder なら付かない', () => {
    const tags = tagMove({ kind: 'chess', phase: 'endgame', quality: 'mistake' });
    expect(tags).not.toContain('endgame_technique');
  });

  it('phase が opening/middlegame なら付かない', () => {
    expect(tagMove({ kind: 'chess', phase: 'opening', quality: 'best' })).not.toContain(
      'endgame_technique',
    );
    expect(tagMove({ kind: 'chess', phase: 'middlegame', quality: 'best' })).not.toContain(
      'endgame_technique',
    );
  });
});

describe('tagMove — 過剰タグ付けの抑制', () => {
  it('quality が mistake/blunder かつ phase===opening ではタグが空でもよい', () => {
    const tags = tagMove({
      kind: 'chess',
      phase: 'opening',
      quality: 'mistake',
      movePlayed: 'e2e4',
    });
    expect(tags).toEqual([]);
  });

  it('タグ数は最大3個に切られる', () => {
    // castle + sacrifice + endgame_technique の3条件を同時に満たす極端な入力を作る。
    const tags = tagMove({
      kind: 'chess',
      phase: 'endgame',
      quality: 'good',
      evalBefore: 0,
      evalAfter: 300,
      movePlayed: 'e1g1',
    });
    expect(tags.length).toBeLessThanOrEqual(3);
  });
});
