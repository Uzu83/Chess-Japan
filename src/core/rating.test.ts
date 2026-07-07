import { describe, it, expect } from 'vitest';
import {
  expectedScore,
  ratingDelta,
  applyResult,
  INITIAL_RATING,
  K_FACTOR,
  RATING_FLOOR,
} from './rating';

describe('expectedScore', () => {
  it('同レートなら期待勝率 0.5', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 5);
  });

  it('400点差なら強い側の期待勝率 ≈ 0.909(Elo の定義)', () => {
    expect(expectedScore(1600, 1200)).toBeCloseTo(1 / (1 + Math.pow(10, -1)), 5);
    expect(expectedScore(1600, 1200)).toBeCloseTo(0.9091, 3);
  });

  it('対称性: E(a,b) + E(b,a) = 1', () => {
    expect(expectedScore(1500, 1300) + expectedScore(1300, 1500)).toBeCloseTo(1, 10);
  });
});

describe('ratingDelta', () => {
  it('同レートで勝つと +K/2 (=+16)', () => {
    expect(ratingDelta(1200, 1200, 1)).toBe(K_FACTOR / 2);
  });

  it('同レートで負けると -K/2 (=-16)', () => {
    expect(ratingDelta(1200, 1200, 0)).toBe(-K_FACTOR / 2);
  });

  it('同レートの引き分けは 0', () => {
    expect(ratingDelta(1200, 1200, 0.5)).toBe(0);
  });

  it('格上に勝つと大きく増え、格下に勝っても少ししか増えない', () => {
    const vsStronger = ratingDelta(1200, 1900, 1); // 格上(+700)に勝利
    const vsWeaker = ratingDelta(1200, 800, 1); // 格下(-400)に勝利
    expect(vsStronger).toBeGreaterThan(25); // ほぼ K に近い
    expect(vsWeaker).toBeLessThanOrEqual(3); // ほぼ増えない
  });

  it('格下に負けると大きく減る', () => {
    expect(ratingDelta(1200, 800, 0)).toBeLessThan(-25);
  });
});

describe('applyResult', () => {
  it('新レートと delta が整合する', () => {
    const r = applyResult(1200, 1400, 1);
    expect(r.rating).toBe(1200 + r.delta);
    expect(r.delta).toBeGreaterThan(K_FACTOR / 2); // 格上に勝った
  });

  it('下限 RATING_FLOOR でクランプされ、delta も実変動に補正される', () => {
    // 床が効くのは「同格に負ける」ケース(格上への敗北は期待通りなのでほぼ変動しない=Eloの正しい挙動)。
    // 110 が同格(100)に負けると数式上 -16 → 94 だが、床 100 で止まり実変動は -10。
    const r = applyResult(RATING_FLOOR + 10, RATING_FLOOR, 0);
    expect(r.rating).toBe(RATING_FLOOR);
    expect(r.delta).toBe(-10);
  });

  it('格上への敗北はほぼ変動しない(期待通りの結果だから)', () => {
    const r = applyResult(RATING_FLOOR + 5, 2000, 0);
    expect(r.delta).toBe(0); // 期待勝率がほぼ0なので負けても減らない
  });

  it('INITIAL_RATING は現実的な初期値(800〜1500 の帯)', () => {
    expect(INITIAL_RATING).toBeGreaterThanOrEqual(800);
    expect(INITIAL_RATING).toBeLessThanOrEqual(1500);
  });
});
