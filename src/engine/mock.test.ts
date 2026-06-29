import { MockEngine } from './mock';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('MockEngine', () => {
  it('開始局面で最善手と複数の読み筋を返す', async () => {
    const engine = new MockEngine();
    await engine.init();
    const r = await engine.analyze(START, { multipv: 3 });
    expect(r.bestMove).not.toBeNull();
    expect(r.lines.length).toBe(3);
    expect(r.lines[0].multipv).toBe(1);
    // 開始局面は互角に近い
    expect(Math.abs(r.lines[0].score.type === 'cp' ? r.lines[0].score.value : 0)).toBeLessThan(100);
  });

  it('決定的(同じFENは同じ結果)', async () => {
    const engine = new MockEngine();
    const a = await engine.analyze(START);
    const b = await engine.analyze(START);
    expect(a.bestMove).toBe(b.bestMove);
  });
});
