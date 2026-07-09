import { evalLabel } from './evalLabel';

/*
 * evalLabel の scale 回帰テスト（2026-07-09「将棋の評価がチェスのポーン換算で出る」対策）。
 * チェス=ポーン換算(cp/100)、将棋=生評価値。詰み(±99000 以上)は両者共通の専用表現。
 */
describe('evalLabel（評価値の表示 scale）', () => {
  it('チェスはポーン換算（cp/100・小数1桁）', () => {
    expect(evalLabel(40, 'chess')).toBe('+0.4');
    expect(evalLabel(-170, 'chess')).toBe('-1.7');
    expect(evalLabel(0, 'chess')).toBe('0.0');
  });

  it('将棋は生の評価値（整数・÷100しない）', () => {
    expect(evalLabel(40, 'shogi')).toBe('+40');
    expect(evalLabel(-170, 'shogi')).toBe('-170');
    expect(evalLabel(0, 'shogi')).toBe('0');
  });

  it('詰み(±99000 以上)は両ゲーム共通の専用表現（巨大数を漏らさない）', () => {
    for (const g of ['chess', 'shogi'] as const) {
      expect(evalLabel(99999, g)).toBe('詰み(勝ち)');
      expect(evalLabel(-99999, g)).toBe('詰み(負け)');
    }
  });

  it('undefined は「—」', () => {
    expect(evalLabel(undefined, 'chess')).toBe('—');
    expect(evalLabel(undefined, 'shogi')).toBe('—');
  });
});
