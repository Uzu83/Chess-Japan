import { shogiGameModel } from './shogiGame';

/*
 * shogiGame.test.ts — KIF パース / 各手 SFEN / USI 手列 / 日本語表記 / 単一 SFEN
 * 期待値は Phase 4-0 スパイク（tsshogi ルール完全性 PASS）と node 実測に基づく。
 */

// 角換わりの出だし4手: 7g7f, 3c3d, 8h2b+(２二角成), 3a2b(同銀)
const KIF = [
  '手合割：平手',
  '先手：先手',
  '後手：後手',
  '手数----指手---------消費時間--',
  '   1 ７六歩(77)',
  '   2 ３四歩(33)',
  '   3 ２二角成(88)',
  '   4 同銀(31)',
].join('\n');

const INITIAL_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('shogiGameModel (KIF)', () => {
  it('KIF をパースして GameModel(kind=shogi) を返す', () => {
    const m = shogiGameModel(KIF);
    expect(m.kind).toBe('shogi');
    expect(m.startFen).toBe(INITIAL_SFEN);
    expect(m.moves.length).toBe(4);
  });

  it('各手の engineMove は USI', () => {
    const m = shogiGameModel(KIF);
    expect(m.moves.map((x) => x.engineMove)).toEqual(['7g7f', '3c3d', '8h2b+', '3a2b']);
  });

  it('各手の label は日本語表記(☗/☖ 付き・駒種・成り)', () => {
    const m = shogiGameModel(KIF);
    expect(m.moves[0].label).toBe('☗７六歩');
    expect(m.moves[1].label).toBe('☖３四歩');
    expect(m.moves[2].label).toBe('☗２二角成'); // 成りが表記に出る
    expect(m.moves[3].label).toContain('銀');
  });

  it('fenAt が各局面の SFEN を返す（0=初期, k=k手目直後）', () => {
    const m = shogiGameModel(KIF);
    expect(m.fenAt(0)).toBe(INITIAL_SFEN);
    // 3手目(２二角成)直後: 先手の馬が2二、先手持駒 角、後手番
    expect(m.fenAt(3)).toBe('lnsgkgsnl/1r5+B1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/7R1/LNSGKGSNL w B 1');
    // 4手目(同銀)直後
    expect(m.fenAt(4)).toBe('lnsgkg1nl/1r5s1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/7R1/LNSGKGSNL b Bb 1');
  });

  it('範囲外の index は端に丸める', () => {
    const m = shogiGameModel(KIF);
    expect(m.fenAt(-5)).toBe(INITIAL_SFEN);
    expect(m.fenAt(999)).toBe(m.fenAt(4)); // 最終局面
  });
});

describe('shogiGameModel (SFEN 単体)', () => {
  it('指し手なしの単一局面も 0 手モデルとして読める', () => {
    const m = shogiGameModel(INITIAL_SFEN);
    expect(m.kind).toBe('shogi');
    expect(m.moves.length).toBe(0);
    expect(m.fenAt(0)).toBe(INITIAL_SFEN);
  });
});

describe('shogiGameModel (異常系・寛容フォールバック)', () => {
  it('解釈できない文字列は初期局面の0手モデルへ寛容に倒す（クラッシュしない）', () => {
    // WHY throw を期待しないか: tsshogi の KIF/CSA インポータは寛容で、未知行を読み飛ばして
    //   「初期局面・0手」の Record を返す（実測）。厳密な棋譜検証 API は無いため、ここでは
    //   「不正入力でも UI を落とさず初期局面を出す」ことを保証する（graceful degradation）。
    const m = shogiGameModel('これは棋譜ではありません !!!???');
    expect(m.kind).toBe('shogi');
    expect(m.moves.length).toBe(0);
    expect(m.fenAt(0)).toBe(INITIAL_SFEN);
  });
});
