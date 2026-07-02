import { normalizeEvalToWhiteCp, computeAccuracySummary, GRAPH_CLAMP_CP } from './evalUtils';
import type { ExplanationContext, MoveRecord } from './types';

// ── テストヘルパー ────────────────────────────────────────────

function makeMove(ply: number, color: 'w' | 'b'): MoveRecord {
  return { ply, san: '', uci: '', fenBefore: '', fenAfter: '', color };
}

function makeCtx(quality: ExplanationContext['quality']): ExplanationContext {
  return { fenOrSfen: '', quality };
}

// ── normalizeEvalToWhiteCp ────────────────────────────────────

describe('normalizeEvalToWhiteCp', () => {
  it('白が指した後: evalAfter をそのまま白視点に使う', () => {
    // 白が指してプラス → 白有利 → 白視点でもプラス
    expect(normalizeEvalToWhiteCp(100, 'w')).toBe(100);
    expect(normalizeEvalToWhiteCp(-50, 'w')).toBe(-50);
    expect(normalizeEvalToWhiteCp(0, 'w')).toBe(0);
  });

  it('黒が指した後: evalAfter を符号反転して白視点に', () => {
    // 黒が指して evalAfter=100(黒有利) → 白視点では -100
    expect(normalizeEvalToWhiteCp(100, 'b')).toBe(-100);
    // 黒が指して evalAfter=-30(黒不利=白有利) → 白視点では +30
    expect(normalizeEvalToWhiteCp(-30, 'b')).toBe(30);
  });

  it('GRAPH_CLAMP_CP で上限を飽和させる(詰み値の保護)', () => {
    // 詰み値 scoreToCp(mate=1) = 99999 → GRAPH_CLAMP_CP にクランプ
    expect(normalizeEvalToWhiteCp(99999, 'w')).toBe(GRAPH_CLAMP_CP);
    expect(normalizeEvalToWhiteCp(-99999, 'w')).toBe(-GRAPH_CLAMP_CP);
  });

  it('黒番の詰み値も反転後にクランプされる', () => {
    // 黒番 evalAfter=99999 → 白視点 -99999 → クランプして -GRAPH_CLAMP_CP
    expect(normalizeEvalToWhiteCp(99999, 'b')).toBe(-GRAPH_CLAMP_CP);
    // 黒番 evalAfter=-99999 → 白視点 +99999 → GRAPH_CLAMP_CP
    expect(normalizeEvalToWhiteCp(-99999, 'b')).toBe(GRAPH_CLAMP_CP);
  });

  it('GRAPH_CLAMP_CP ちょうどの値はクランプしない(境界値)', () => {
    expect(normalizeEvalToWhiteCp(GRAPH_CLAMP_CP, 'w')).toBe(GRAPH_CLAMP_CP);
    expect(normalizeEvalToWhiteCp(-GRAPH_CLAMP_CP, 'w')).toBe(-GRAPH_CLAMP_CP);
  });
});

// ── computeAccuracySummary ────────────────────────────────────

describe('computeAccuracySummary', () => {
  const moves: MoveRecord[] = [
    makeMove(0, 'w'), // ply 0: 白
    makeMove(1, 'b'), // ply 1: 黒
    makeMove(2, 'w'), // ply 2: 白
    makeMove(3, 'b'), // ply 3: 黒
  ];

  it('白/黒の手質を正しく分けて集計する', () => {
    const contexts: Record<number, ExplanationContext> = {
      0: makeCtx('best'), // 白: 最善
      1: makeCtx('blunder'), // 黒: 悪手
      2: makeCtx('good'), // 白: 好手
      3: makeCtx('mistake'), // 黒: 疑問手
    };
    const s = computeAccuracySummary(contexts, moves);

    // 白
    expect(s.white.best).toBe(1);
    expect(s.white.good).toBe(1);
    expect(s.white.blunder).toBe(0);
    expect(s.whiteTotal).toBe(2);

    // 黒
    expect(s.black.blunder).toBe(1);
    expect(s.black.mistake).toBe(1);
    expect(s.black.best).toBe(0);
    expect(s.blackTotal).toBe(2);
  });

  it('未解析(コンテキストが存在しない)手は集計しない', () => {
    const contexts: Record<number, ExplanationContext> = {
      0: makeCtx('best'), // ply 0 のみ解析済み
      // ply 1, 2, 3 は未解析
    };
    const s = computeAccuracySummary(contexts, moves);

    expect(s.whiteTotal).toBe(1);
    expect(s.blackTotal).toBe(0);
    expect(s.black.blunder).toBe(0);
    expect(s.white.best).toBe(1);
  });

  it('quality が undefined の context は集計対象外', () => {
    const contexts: Record<number, ExplanationContext> = {
      0: { fenOrSfen: '' }, // quality なし(解析中断等)
      1: makeCtx('good'),
    };
    const s = computeAccuracySummary(contexts, moves);

    // ply 0 は quality 未設定 → カウントされない
    expect(s.whiteTotal).toBe(0);
    expect(s.blackTotal).toBe(1);
    expect(s.black.good).toBe(1);
  });

  it('空の contexts は全カテゴリゼロを返す', () => {
    const s = computeAccuracySummary({}, moves);

    expect(s.whiteTotal).toBe(0);
    expect(s.blackTotal).toBe(0);
    expect(s.white.best).toBe(0);
    expect(s.black.blunder).toBe(0);
  });

  it('同じ色の同じ quality が複数あれば正しく加算される', () => {
    const contexts: Record<number, ExplanationContext> = {
      0: makeCtx('blunder'), // 白
      2: makeCtx('blunder'), // 白(2手目の白)
    };
    const s = computeAccuracySummary(contexts, moves);

    expect(s.white.blunder).toBe(2);
    expect(s.whiteTotal).toBe(2);
  });
});
