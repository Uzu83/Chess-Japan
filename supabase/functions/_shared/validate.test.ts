import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  byteLengthOf,
  cacheKeyInput,
  validateExplainBody,
} from './validate';

// 正当な最小ボディ（explain）。各テストでスプレッドして一部だけ壊す。
const validExplain = {
  mode: 'explain',
  game: 'chess',
  context: { fenOrSfen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', movePlayed: 'e2e4' },
};

describe('byteLengthOf', () => {
  it('ASCII はバイト数=文字数', () => {
    expect(byteLengthOf('abc')).toBe(3);
  });
  it('日本語は UTF-16 文字数より多い（C3 の核心: str.length では過小判定になる）', () => {
    const s = 'あ'; // UTF-16 長は 1 だが UTF-8 では 3 バイト
    expect(s.length).toBe(1);
    expect(byteLengthOf(s)).toBe(3);
  });
  it('絵文字（サロゲートペア）も実バイトで測れる', () => {
    expect(byteLengthOf('😀')).toBe(4);
  });
  it('MAX_BODY_BYTES は 16KB', () => {
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
  });
});

describe('validateExplainBody: 正常系', () => {
  it('最小の explain を通す', () => {
    const r = validateExplainBody(validExplain);
    expect(r.ok).toBe(true);
  });

  it('followup は question 必須', () => {
    const ok = validateExplainBody({ ...validExplain, mode: 'followup', question: 'ピンって何？' });
    expect(ok.ok).toBe(true);
    const ng = validateExplainBody({ ...validExplain, mode: 'followup' });
    expect(ng.ok).toBe(false);
  });

  it('pv は上限件数で切り詰める', () => {
    const pv = Array.from({ length: 100 }, () => 'e2e4');
    const r = validateExplainBody({ ...validExplain, context: { ...validExplain.context, pv } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.context.pv!.length).toBe(40);
  });

  it('history は直近10件に絞り、各内容を切り詰める', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(5000),
    }));
    const r = validateExplainBody({ ...validExplain, mode: 'followup', question: 'q', history });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.history!.length).toBe(10);
      expect(r.value.history![0].content.length).toBe(2000);
    }
  });
});

describe('validateExplainBody: 異常系（攻撃面）', () => {
  it('object でない', () => {
    expect(validateExplainBody(null).ok).toBe(false);
    expect(validateExplainBody('x').ok).toBe(false);
  });
  it('mode/game enum 外を弾く', () => {
    expect(validateExplainBody({ ...validExplain, mode: 'hack' }).ok).toBe(false);
    expect(validateExplainBody({ ...validExplain, game: 'go' }).ok).toBe(false);
  });
  it('fenOrSfen 欠落・過大を弾く', () => {
    expect(validateExplainBody({ ...validExplain, context: {} }).ok).toBe(false);
    const huge = 'a'.repeat(201);
    expect(validateExplainBody({ ...validExplain, context: { fenOrSfen: huge } }).ok).toBe(false);
  });
  it('評価値の Infinity/NaN/範囲外を弾く（分類ロジック破壊攻撃の防止）', () => {
    expect(
      validateExplainBody({ ...validExplain, context: { ...validExplain.context, evalBefore: Infinity } }).ok,
    ).toBe(false);
    expect(
      validateExplainBody({ ...validExplain, context: { ...validExplain.context, evalAfter: Number.NaN } }).ok,
    ).toBe(false);
    expect(
      validateExplainBody({ ...validExplain, context: { ...validExplain.context, evalBefore: 9_999_999 } }).ok,
    ).toBe(false);
  });
  it('quality enum 外を弾く', () => {
    expect(
      validateExplainBody({ ...validExplain, context: { ...validExplain.context, quality: 'genius' } }).ok,
    ).toBe(false);
  });
  it('question 過大を弾く', () => {
    expect(
      validateExplainBody({ ...validExplain, mode: 'followup', question: 'q'.repeat(501) }).ok,
    ).toBe(false);
  });
  it('history role/型不正を弾く', () => {
    expect(
      validateExplainBody({ ...validExplain, mode: 'followup', question: 'q', history: [{ role: 'system', content: 'x' }] }).ok,
    ).toBe(false);
  });

  // Codex 指摘3: テールバイパス防止。上限件数を超えた位置の不正要素も検証する。
  it('pv の上限超過位置にある非文字列も弾く（テールバイパス防止）', () => {
    const pv = [...Array.from({ length: 40 }, () => 'e2e4'), 123];
    expect(
      validateExplainBody({ ...validExplain, context: { ...validExplain.context, pv } }).ok,
    ).toBe(false);
  });
  it('history の直近10件より前の不正要素も弾く（全要素検証）', () => {
    const history = [
      { role: 'system', content: 'inject' }, // 先頭の不正
      ...Array.from({ length: 12 }, () => ({ role: 'user', content: 'ok' })),
    ];
    expect(
      validateExplainBody({ ...validExplain, mode: 'followup', question: 'q', history }).ok,
    ).toBe(false);
  });
});

// Codex 指摘2: ユーザー語彙の制御文字を無害化（プロンプト注入緩和）。
describe('validateExplainBody: 制御文字の無害化', () => {
  it('profile 用語の改行・タブを空白化する', () => {
    const r = validateExplainBody({
      ...validExplain,
      profile: { known: ['pi\nn', 'fo\trk'], unknown: [], level: 'beginner' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 改行/タブが残っていないこと
      for (const term of r.value.profile!.known) {
        expect(term).not.toMatch(/[\n\r\t]/);
      }
    }
  });
});

describe('cacheKeyInput', () => {
  it('explain の主要事実を決定的に並べる（level 既定 beginner）', () => {
    const r = validateExplainBody(validExplain);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const key = cacheKeyInput(r.value);
      expect(key).toEqual({
        game: 'chess',
        fenOrSfen: validExplain.context.fenOrSfen,
        movePlayed: 'e2e4',
        bestMove: null,
        evalBefore: null,
        evalAfter: null,
        quality: null,
        level: 'beginner',
      });
    }
  });
  it('level が違えば別キャッシュ（解説文面が変わるため）', () => {
    const a = validateExplainBody({ ...validExplain, profile: { known: [], unknown: [], level: 'advanced' } });
    const b = validateExplainBody(validExplain);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(cacheKeyInput(a.value).level).not.toBe(cacheKeyInput(b.value).level);
  });
});
