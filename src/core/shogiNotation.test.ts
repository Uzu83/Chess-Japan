import { usiToJapanese, usiLineToJapanese, localShogiExplanation } from './shogiNotation';
import type { ExplanationContext } from './types';

/*
 * shogiNotation.test.ts — USI→日本語変換 と 将棋ローカル簡易解説
 * 期待値は Phase 4-0 スパイク usi_japanese_roundtrip PASS（☗７六歩）に基づく。
 */

const INITIAL_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('usiToJapanese', () => {
  it('初手 7g7f → ☗７六歩', () => {
    expect(usiToJapanese(INITIAL_SFEN, '7g7f')).toBe('☗７六歩');
  });
  it('不正 SFEN / 不正手は null', () => {
    expect(usiToJapanese('not-a-sfen', '7g7f')).toBeNull();
    expect(usiToJapanese(INITIAL_SFEN, 'zzzz')).toBeNull();
  });
});

describe('usiLineToJapanese', () => {
  it('USI 手順を順に適用して日本語列に変換する', () => {
    const jp = usiLineToJapanese(INITIAL_SFEN, ['7g7f', '3c3d', '8h2b+'], 6);
    expect(jp).toEqual(['☗７六歩', '☖３四歩', '☗２二角成']);
  });
  it('maxPlies で打ち切る', () => {
    const jp = usiLineToJapanese(INITIAL_SFEN, ['7g7f', '3c3d', '8h2b+'], 2);
    expect(jp.length).toBe(2);
  });
});

describe('localShogiExplanation', () => {
  const base: ExplanationContext = {
    fenOrSfen: INITIAL_SFEN,
    movePlayed: '1g1f', // わざと最善でない手
    evalBefore: 50,
    evalAfter: -80,
    bestMove: '7g7f',
    pv: ['7g7f', '3c3d'],
    quality: 'inaccuracy',
  };

  it('手の質・評価・最善手（日本語）を含む', () => {
    const text = localShogiExplanation({ context: base, mode: 'explain' });
    expect(text).toContain('不正確'); // quality ラベル
    expect(text).toContain('☗７六歩'); // 最善手が日本語表記で出る
  });

  it('followup は質問を含むローカル応答', () => {
    const text = localShogiExplanation({
      context: base,
      mode: 'followup',
      question: 'どういうこと?',
    });
    expect(text).toContain('どういうこと?');
  });
});
