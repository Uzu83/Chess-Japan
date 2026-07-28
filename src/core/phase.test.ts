import { classifyPhase } from './phase';

const CHESS_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// クイーン両者なし・両者にビショップ2枚(残り駒4)だけ残る終盤想定局面。
const CHESS_NO_QUEENS = '4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1';
// クイーンのみ両者消滅・他は初期配置どおり(残り駒28で閾値6を大きく超える) = queens=0 単独で endgame になるか検証。
const CHESS_NO_QUEENS_MANY_PIECES = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1';
// クイーンは両者に残っているが、他は玉のみ(残り駒2)= 駒僅少の終盤。
const CHESS_FEW_PIECES = '4k3/8/8/8/3q4/8/8/3QK3 w - - 0 1';
// 中盤相当(クイーン残存・駒も多い)。
const CHESS_MIDGAME = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

const SHOGI_START = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
// 角・飛(成りも含む)が両者ともゼロの終盤想定局面(玉のみ+歩少々)。
const SHOGI_NO_MAJORS = '4k4/9/4P4/9/9/9/9/9/4K4 b - 1';
// 残り駒が僅少(玉+歩1枚のみ、大駒は残っているが枚数条件で終盤)。
const SHOGI_FEW_PIECES = '3bk4/9/9/9/9/9/9/9/4K4 b - 1';
// 大駒は両者0だが歩が多数(残り駒18で閾値10を超える) = 大駒消滅条件が単独で効くか検証。
const SHOGI_NO_MAJORS_MANY_PIECES = '4k4/9/PPPPPPPPP/9/9/9/ppppppppp/9/4K4 b - 1';

describe('classifyPhase (chess)', () => {
  it('ply<=20 は常に opening(初期局面)', () => {
    expect(classifyPhase({ kind: 'chess', ply: 0, fenOrSfen: CHESS_START })).toBe('opening');
    expect(classifyPhase({ kind: 'chess', ply: 20, fenOrSfen: CHESS_MIDGAME })).toBe('opening');
  });

  it('ply<=20 なら駒が極端に少なくても opening を優先する(仕様どおりの優先順位)', () => {
    expect(classifyPhase({ kind: 'chess', ply: 5, fenOrSfen: CHESS_FEW_PIECES })).toBe('opening');
  });

  it('ply>20 かつクイーン両者0 は endgame', () => {
    expect(classifyPhase({ kind: 'chess', ply: 21, fenOrSfen: CHESS_NO_QUEENS })).toBe('endgame');
  });

  it('クイーン両者0 なら残り駒が多くても endgame(クイーン消滅条件が単独で効く)', () => {
    expect(classifyPhase({ kind: 'chess', ply: 21, fenOrSfen: CHESS_NO_QUEENS_MANY_PIECES })).toBe(
      'endgame',
    );
  });

  it('ply>20 かつ残り駒<=6 は endgame(クイーンが残っていても)', () => {
    expect(classifyPhase({ kind: 'chess', ply: 21, fenOrSfen: CHESS_FEW_PIECES })).toBe('endgame');
  });

  it('ply>20 かつクイーン健在・駒も多いなら middlegame', () => {
    expect(classifyPhase({ kind: 'chess', ply: 21, fenOrSfen: CHESS_MIDGAME })).toBe('middlegame');
  });
});

describe('classifyPhase (shogi)', () => {
  it('ply<=30 は常に opening(初期局面)', () => {
    expect(classifyPhase({ kind: 'shogi', ply: 0, fenOrSfen: SHOGI_START })).toBe('opening');
    expect(classifyPhase({ kind: 'shogi', ply: 30, fenOrSfen: SHOGI_START })).toBe('opening');
  });

  it('ply<=30 なら駒が極端に少なくても opening を優先する', () => {
    expect(classifyPhase({ kind: 'shogi', ply: 10, fenOrSfen: SHOGI_NO_MAJORS })).toBe('opening');
  });

  it('ply>30 かつ大駒(角飛・成り含む)両者0 は endgame', () => {
    expect(classifyPhase({ kind: 'shogi', ply: 31, fenOrSfen: SHOGI_NO_MAJORS })).toBe('endgame');
  });

  it('大駒両者0 なら残り駒が多くても endgame(大駒消滅条件が単独で効く)', () => {
    expect(classifyPhase({ kind: 'shogi', ply: 31, fenOrSfen: SHOGI_NO_MAJORS_MANY_PIECES })).toBe(
      'endgame',
    );
  });

  it('ply>30 かつ残り駒<=10 は endgame(大駒が残っていても)', () => {
    expect(classifyPhase({ kind: 'shogi', ply: 31, fenOrSfen: SHOGI_FEW_PIECES })).toBe('endgame');
  });

  it('成角/成飛(+B/+R)も大駒として数える(消えていれば endgame)', () => {
    // 玉のみ + 成銀1枚(+S): 大駒は0だが残り駒3で endgame 条件にも合致
    const sfen = '4k4/9/9/9/9/9/9/9/3+SK3 b - 1';
    expect(classifyPhase({ kind: 'shogi', ply: 31, fenOrSfen: sfen })).toBe('endgame');
  });

  it('ply>30 かつ大駒健在・駒も多いなら middlegame', () => {
    // 平手初形から少し進んだ想定の粗い中盤局面(大駒健在・駒多数)。
    const sfen = 'lnsgkgsnl/1r5b1/pppp1pppp/9/4p4/9/PPPP1PPPP/1B5R1/LNSGKGSNL w - 1';
    expect(classifyPhase({ kind: 'shogi', ply: 31, fenOrSfen: sfen })).toBe('middlegame');
  });
});
