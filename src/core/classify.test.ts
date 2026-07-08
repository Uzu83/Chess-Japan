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

describe('classifyByLoss (GameKind 別閾値)', () => {
  it('第4引数省略時の既定は chess（既存挙動と一致）', () => {
    // 明示 'chess' でも省略でも同じ結果（後方互換）
    expect(classifyByLoss(50, -120, false)).toBe('mistake'); // loss 170
    expect(classifyByLoss(50, -120, false, 'chess')).toBe('mistake');
  });

  it('shogi はチェスより粗い閾値（30/120/300/700）', () => {
    expect(classifyByLoss(100, 80, false, 'shogi')).toBe('best'); // loss 20 ≤ 30
    expect(classifyByLoss(200, 100, false, 'shogi')).toBe('good'); // loss 100 ≤ 120
    expect(classifyByLoss(400, 150, false, 'shogi')).toBe('inaccuracy'); // loss 250 ≤ 300
    expect(classifyByLoss(800, 200, false, 'shogi')).toBe('mistake'); // loss 600 ≤ 700
    expect(classifyByLoss(1000, 100, false, 'shogi')).toBe('blunder'); // loss 900 > 700
  });

  it('同じ loss でも chess と shogi で分類が変わる（loss 250）', () => {
    expect(classifyByLoss(250, 0, false, 'chess')).toBe('blunder'); // chess: >200
    expect(classifyByLoss(250, 0, false, 'shogi')).toBe('inaccuracy'); // shogi: ≤300
  });

  it('最善手は kind に依らず best', () => {
    expect(classifyByLoss(500, -500, true, 'shogi')).toBe('best');
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
