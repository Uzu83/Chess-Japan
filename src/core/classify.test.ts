import { buildExplanationContext, classifyByLoss, negateScore, scoreToCp } from './classify';

describe('scoreToCp', () => {
  it('cp はそのまま', () => {
    expect(scoreToCp({ type: 'cp', value: 35 })).toBe(35);
  });
  it('mate は大きな値に換算(手数が短いほど大)', () => {
    expect(scoreToCp({ type: 'mate', value: 1 })).toBeGreaterThan(
      scoreToCp({ type: 'mate', value: 5 }),
    );
    expect(scoreToCp({ type: 'mate', value: -1 })).toBeLessThan(0);
  });
});

describe('negateScore', () => {
  it('cp/mate を反転する', () => {
    expect(negateScore({ type: 'cp', value: 20 })).toEqual({ type: 'cp', value: -20 });
    expect(negateScore({ type: 'mate', value: 3 })).toEqual({ type: 'mate', value: -3 });
  });
});

describe('classifyByLoss', () => {
  it('最善手は best', () => {
    expect(classifyByLoss(50, -300, true)).toBe('best');
  });
  it('損失に応じて分類', () => {
    expect(classifyByLoss(50, 45, false)).toBe('best'); // loss 5
    expect(classifyByLoss(50, 10, false)).toBe('good'); // loss 40
    expect(classifyByLoss(50, -30, false)).toBe('inaccuracy'); // loss 80
    expect(classifyByLoss(50, -120, false)).toBe('mistake'); // loss 170
    expect(classifyByLoss(50, -300, false)).toBe('blunder'); // loss 350
  });
});

describe('buildExplanationContext', () => {
  it('大悪手を検出する(最善は+50だが指した後は相手+250=自分-250)', () => {
    const ctx = buildExplanationContext({
      fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      movePlayed: 'a2a3',
      bestScore: { type: 'cp', value: 50 },
      bestMove: 'e2e4',
      pv: ['e2e4', 'e7e5'],
      scoreAfter: { type: 'cp', value: 250 }, // 相手番視点で+250
    });
    expect(ctx.evalBefore).toBe(50);
    expect(ctx.evalAfter).toBe(-250);
    expect(ctx.quality).toBe('blunder');
    expect(ctx.bestMove).toBe('e2e4');
  });

  it('最善手なら best', () => {
    const ctx = buildExplanationContext({
      fenBefore: 'startpos-fen',
      movePlayed: 'e2e4',
      bestScore: { type: 'cp', value: 30 },
      bestMove: 'e2e4',
      pv: ['e2e4'],
      scoreAfter: { type: 'cp', value: -30 },
    });
    expect(ctx.quality).toBe('best');
  });
});
