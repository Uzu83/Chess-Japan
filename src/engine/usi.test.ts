import { parseInfoLine, parseUsiBestMove } from './usi';

/*
 * usi.test.ts — USI パーサ（bestmove の判別 union + info 行の共有パース）
 * WHY: 将棋特有の bestmove resign/win を「実手」と取り違えない型分離（Codex ゲート① #5）を回帰で守る。
 */

describe('parseUsiBestMove', () => {
  it('実手（盤上の手）', () => {
    expect(parseUsiBestMove('bestmove 7g7f ponder 3c3d')).toEqual({ kind: 'move', usi: '7g7f' });
    expect(parseUsiBestMove('bestmove 8h2b+')).toEqual({ kind: 'move', usi: '8h2b+' });
  });
  it('打ち手（持ち駒を打つ）も実手', () => {
    expect(parseUsiBestMove('bestmove P*5e')).toEqual({ kind: 'move', usi: 'P*5e' });
  });
  it('投了 resign / 入玉宣言勝ち win を実手と区別する', () => {
    expect(parseUsiBestMove('bestmove resign')).toEqual({ kind: 'resign' });
    expect(parseUsiBestMove('bestmove win')).toEqual({ kind: 'win' });
  });
  it('(none) / 空は none', () => {
    expect(parseUsiBestMove('bestmove (none)')).toEqual({ kind: 'none' });
    expect(parseUsiBestMove('bestmove')).toEqual({ kind: 'none' });
  });
  it('bestmove 行でなければ null', () => {
    expect(parseUsiBestMove('info depth 1')).toBeNull();
    expect(parseUsiBestMove('usiok')).toBeNull();
  });
});

describe('parseInfoLine (USI 共有)', () => {
  it('score cp と USI 手順を解析する', () => {
    const r = parseInfoLine(
      'info depth 12 seldepth 15 multipv 1 score cp 42 nodes 9999 pv 7g7f 3c3d 2g2f',
    );
    expect(r).not.toBeNull();
    expect(r!.depth).toBe(12);
    expect(r!.multipv).toBe(1);
    expect(r!.score).toEqual({ type: 'cp', value: 42 });
    expect(r!.moves).toEqual(['7g7f', '3c3d', '2g2f']);
  });
  it('score mate を解析する', () => {
    const r = parseInfoLine('info depth 20 multipv 1 score mate 5 pv 2b3a');
    expect(r!.score).toEqual({ type: 'mate', value: 5 });
  });
  it('打ち手を含む pv も通る', () => {
    const r = parseInfoLine('info depth 8 multipv 2 score cp -30 pv P*5e 5d5e');
    expect(r!.multipv).toBe(2);
    expect(r!.moves).toEqual(['P*5e', '5d5e']);
  });
  it('pv の無い行は無視する', () => {
    expect(parseInfoLine('info depth 1 score cp 0 nodes 20')).toBeNull();
    expect(parseInfoLine('usiok')).toBeNull();
  });
});
