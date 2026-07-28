import { aggregateStrength, type AnalyzedPly } from './strengthAggregator';

function ply(overrides: Partial<AnalyzedPly> & Pick<AnalyzedPly, 'ply' | 'quality'>): AnalyzedPly {
  return {
    color: 'w',
    isUserMove: true,
    phase: 'middlegame',
    tags: [],
    ...overrides,
  };
}

describe('aggregateStrength — 基本集計', () => {
  it('isUserMove===false の手は集計から除外する', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best' }),
      ply({ ply: 1, quality: 'blunder', isUserMove: false, color: 'b' }),
    ]);
    expect(report.userMoveCount).toBe(1);
    expect(report.qualityCounts.blunder).toBe(0);
  });

  it('qualityCounts は各 quality の出現数', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best' }),
      ply({ ply: 2, quality: 'best' }),
      ply({ ply: 4, quality: 'good' }),
      ply({ ply: 6, quality: 'mistake' }),
      ply({ ply: 8, quality: 'blunder' }),
    ]);
    expect(report.qualityCounts).toEqual({
      best: 2,
      good: 1,
      inaccuracy: 0,
      mistake: 1,
      blunder: 1,
    });
    expect(report.userMoveCount).toBe(5);
  });

  it('blunderRate = blunder数 / userMoveCount', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'blunder' }),
      ply({ ply: 2, quality: 'best' }),
      ply({ ply: 4, quality: 'best' }),
      ply({ ply: 6, quality: 'best' }),
    ]);
    expect(report.blunderRate).toBe(0.25);
  });

  it('accuracyScore = quality採点(best100/good80/inaccuracy50/mistake20/blunder0)の平均', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best' }), // 100
      ply({ ply: 2, quality: 'good' }), // 80
      ply({ ply: 4, quality: 'blunder' }), // 0
    ]);
    expect(report.accuracyScore).toBeCloseTo(60, 5); // (100+80+0)/3
  });

  it('ユーザー手が0件なら 0 で安全側に返す(0除算回避)', () => {
    const report = aggregateStrength([ply({ ply: 0, quality: 'best', isUserMove: false })]);
    expect(report.userMoveCount).toBe(0);
    expect(report.blunderRate).toBe(0);
    expect(report.accuracyScore).toBe(0);
  });
});

describe('aggregateStrength — byPhase', () => {
  it('フェーズ別に moveCount/blunderRate/accuracyScore を分けて集計する', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best', phase: 'opening' }),
      ply({ ply: 2, quality: 'mistake', phase: 'opening' }),
      ply({ ply: 20, quality: 'blunder', phase: 'endgame' }),
    ]);
    expect(report.byPhase.opening.moveCount).toBe(2);
    expect(report.byPhase.opening.accuracyScore).toBeCloseTo(60, 5); // (100+20)/2
    expect(report.byPhase.middlegame.moveCount).toBe(0);
    expect(report.byPhase.middlegame.blunderRate).toBe(0);
    expect(report.byPhase.endgame.moveCount).toBe(1);
    expect(report.byPhase.endgame.blunderRate).toBe(1);
  });
});

describe('aggregateStrength — tagStats / strengths / weaknesses', () => {
  it('頻度高(>=2)+成功率高(>=0.6) のタグは strength', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best', tags: ['endgame_technique'] }),
      ply({ ply: 2, quality: 'good', tags: ['endgame_technique'] }),
      ply({ ply: 4, quality: 'best', tags: ['endgame_technique'] }),
    ]);
    const stat = report.tagStats.find((t) => t.tag === 'endgame_technique');
    expect(stat).toBeDefined();
    expect(stat?.count).toBe(3);
    expect(stat?.successRate).toBe(1);
    expect(stat?.kind).toBe('strength');
    expect(report.strengths.length).toBe(1);
    expect(report.weaknesses.length).toBe(0);
  });

  it('頻度高(>=2)+成功率低(<=0.4) のタグは weakness', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'blunder', tags: ['sacrifice'] }),
      ply({ ply: 2, quality: 'mistake', tags: ['sacrifice'] }),
      ply({ ply: 4, quality: 'good', tags: ['sacrifice'] }),
    ]);
    const stat = report.tagStats.find((t) => t.tag === 'sacrifice');
    expect(stat?.successRate).toBeCloseTo(1 / 3, 5);
    expect(stat?.kind).toBe('weakness');
    expect(report.weaknesses.length).toBe(1);
    expect(report.strengths.length).toBe(0);
  });

  it('出現1回だけのタグはサンプル不足として neutral(strength/weaknessに入れない)', () => {
    const report = aggregateStrength([ply({ ply: 0, quality: 'best', tags: ['castle'] })]);
    const stat = report.tagStats.find((t) => t.tag === 'castle');
    expect(stat?.kind).toBe('neutral');
    expect(report.strengths.length).toBe(0);
    expect(report.weaknesses.length).toBe(0);
  });

  it('成功率が中間(0.4〜0.6の間)のタグは neutral', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best', tags: ['exchange'] }),
      ply({ ply: 2, quality: 'blunder', tags: ['exchange'] }),
    ]);
    const stat = report.tagStats.find((t) => t.tag === 'exchange');
    expect(stat?.successRate).toBe(0.5);
    expect(stat?.kind).toBe('neutral');
  });

  it('タグ集計は isUserMove===false の手を含めない', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best', tags: ['castle'] }),
      ply({ ply: 1, quality: 'best', tags: ['castle'], isUserMove: false, color: 'b' }),
    ]);
    const stat = report.tagStats.find((t) => t.tag === 'castle');
    expect(stat?.count).toBe(1);
  });

  it('strengths/weaknesses は日本語の短い説明文を返す', () => {
    const report = aggregateStrength([
      ply({ ply: 0, quality: 'best', tags: ['endgame_technique'] }),
      ply({ ply: 2, quality: 'best', tags: ['endgame_technique'] }),
    ]);
    expect(report.strengths[0]).toMatch(/得意/);
    expect(typeof report.strengths[0]).toBe('string');
  });
});
