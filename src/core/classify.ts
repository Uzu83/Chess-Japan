import type { ExplanationContext, MoveQuality, Score } from './types';

/** 詰みを十分大きなセンチポーン値に換算する際の基準。 */
const MATE_BASE = 100_000;

/** Score を手番側視点のセンチポーン値へ換算(詰みは手数が短いほど大)。 */
export function scoreToCp(score: Score): number {
  if (score.type === 'cp') return score.value;
  const sign = score.value >= 0 ? 1 : -1;
  return sign * (MATE_BASE - Math.abs(score.value));
}

/** 評価値を反転(手番が入れ替わったときに視点を揃える)。 */
export function negateScore(score: Score): Score {
  return score.type === 'cp'
    ? { type: 'cp', value: -score.value }
    : { type: 'mate', value: -score.value };
}

/**
 * 手の質を分類する。
 * @param bestCp   その局面での最善手の評価値(手番側視点, cp換算)
 * @param playedCp 実際に指した手の評価値(同じ手番側視点, cp換算)
 * @param isBestMove 指した手が最善手と一致するか
 */
export function classifyByLoss(bestCp: number, playedCp: number, isBestMove: boolean): MoveQuality {
  if (isBestMove) return 'best';
  const loss = Math.max(0, bestCp - playedCp);
  if (loss <= 10) return 'best';
  if (loss <= 50) return 'good';
  if (loss <= 100) return 'inaccuracy';
  if (loss <= 200) return 'mistake';
  return 'blunder';
}

const QUALITY_LABEL_JA: Record<MoveQuality, string> = {
  best: '最善手',
  good: '好手',
  inaccuracy: '不正確',
  mistake: '疑問手',
  blunder: '悪手',
};

export function qualityLabelJa(q: MoveQuality): string {
  return QUALITY_LABEL_JA[q];
}

/**
 * 指し手前後の解析結果から、LLM へ渡す構造化コンテキストを組み立てる。
 * @param fenBefore   指す前の局面(手番=指し手のプレイヤー)
 * @param movePlayed  指した手(UCI)
 * @param bestScore   指す前の最善手の評価値(手番側視点)
 * @param bestMove    最善手(UCI)
 * @param pv          最善手の読み筋(UCI列)
 * @param scoreAfter  指した後の局面の評価値(=相手番視点。内部で反転して揃える)
 */
export function buildExplanationContext(params: {
  fenBefore: string;
  movePlayed: string;
  bestScore: Score;
  bestMove: string;
  pv: string[];
  scoreAfter: Score;
}): ExplanationContext {
  const { fenBefore, movePlayed, bestScore, bestMove, pv, scoreAfter } = params;
  const playedScore = negateScore(scoreAfter); // 相手番視点 → 手番側視点へ
  const bestCp = scoreToCp(bestScore);
  const playedCp = scoreToCp(playedScore);
  const isBestMove = movePlayed === bestMove;
  const quality = classifyByLoss(bestCp, playedCp, isBestMove);

  return {
    fenOrSfen: fenBefore,
    movePlayed,
    evalBefore: bestCp,
    evalAfter: playedCp,
    bestMove,
    pv,
    quality,
  };
}
