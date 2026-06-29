import { parseBestMove, parseInfoLine } from './uci';

describe('parseInfoLine', () => {
  it('cp スコアと読み筋を解析する', () => {
    const r = parseInfoLine(
      'info depth 18 seldepth 24 multipv 1 score cp 35 nodes 12345 pv e2e4 e7e5 g1f3',
    );
    expect(r).not.toBeNull();
    expect(r!.depth).toBe(18);
    expect(r!.multipv).toBe(1);
    expect(r!.score).toEqual({ type: 'cp', value: 35 });
    expect(r!.moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });

  it('mate スコアを解析する', () => {
    const r = parseInfoLine('info depth 30 multipv 2 score mate 3 pv d1h5 g6h5');
    expect(r!.score).toEqual({ type: 'mate', value: 3 });
    expect(r!.multipv).toBe(2);
  });

  it('pv の無い行は無視する', () => {
    expect(parseInfoLine('info depth 1 score cp 0 nodes 20')).toBeNull();
    expect(parseInfoLine('readyok')).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('最善手を取り出す', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4');
    expect(parseBestMove('bestmove g1f3')).toBe('g1f3');
  });
  it('(none) は null', () => {
    expect(parseBestMove('bestmove (none)')).toBeNull();
    expect(parseBestMove('info depth 1')).toBeNull();
  });
});
