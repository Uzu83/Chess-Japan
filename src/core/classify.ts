import type { ExplanationContext, GameKind, MoveQuality, Score } from './types';

/** 詰みを十分大きなセンチポーン値に換算する際の基準。 */
const MATE_BASE = 100_000;

/*
 * 手の質を分ける損失(centipawn)閾値テーブル（GameKind 別・Codex ゲート① 合意 #4）。
 *
 * loss(最善との評価差) が
 *   ≤ best        → best（最善級）
 *   ≤ good        → good（好手）
 *   ≤ inaccuracy  → inaccuracy（不正確）
 *   ≤ mistake     → mistake（疑問手）
 *   それ超         → blunder（悪手）
 *
 * chess（現行値を1つも変えない・回帰厳禁）:
 *   Phase 0/1 から使ってきた lichess 準拠の値。classify.test.ts の期待値がこの値に依存しているため、
 *   将棋対応で **絶対に動かさない**（動かすと既存 173 テストが割れる）。
 *
 * shogi（暫定値・要実測調整）:
 *   WHY chess より粗いか（駒価値スケールの違い）:
 *     やねうら王(NNUE)の評価値は centipawn 相当だが、駒価値スケールがチェスと違う。将棋では
 *     歩 ≈ 90〜100cp、香/桂 ≈ 100〜300、銀/金 ≈ 400〜600、角/飛 ≈ 600〜1000+ と 1 手の得失が大きく、
 *     中終盤の評価の振れ幅もチェスより大きい。チェスの「200cp で悪手」をそのまま将棋に当てると
 *     「1歩ばね返り」程度の揺れまで悪手判定してしまい過検出になる。よって全体を粗くする。
 *   これらは Phase 4-0 スパイクの実測に基づく **暫定値**。将棋の実棋譜での分布が取れ次第、
 *     docs/PLAN.md の Phase 4-1 記録に沿って再調整する前提（＝確定値ではない）。
 *   例の目安: 30(ほぼ最善) / 120(≈1歩) / 300(≈2〜3歩・軽い損) / 700(≈小駒〜大駒得寸前) / それ超=悪手。
 */
const LOSS_THRESHOLDS: Record<
  GameKind,
  { best: number; good: number; inaccuracy: number; mistake: number }
> = {
  chess: { best: 10, good: 50, inaccuracy: 100, mistake: 200 },
  shogi: { best: 30, good: 120, inaccuracy: 300, mistake: 700 },
};

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
 * @param kind     ゲーム種別。閾値テーブル(LOSS_THRESHOLDS)を切り替える。既定 'chess'。
 *
 * WHY 第4引数を「省略可能・既定 chess」にしたか（既存テスト非破壊の要）:
 *   Codex ゲート① #4 は「classifyByLoss を kind 別閾値に拡張」だが、classify.test.ts は
 *   3引数(bestCp, playedCp, isBestMove)で呼び、期待値がチェス閾値に依存している。
 *   その assertion は変更禁止（CLAUDE.md / 指示）。そこで **既存3引数呼び出しを一切壊さないよう
 *   第4引数を末尾 optional(既定 'chess')** として足した。3引数呼び出し＝チェス閾値のまま不変、
 *   将棋は明示的に 'shogi' を渡したときだけ粗い閾値になる。実質「loss と kind で分類」という #4 の
 *   意図を、後方互換を保ったまま実現している。
 */
export function classifyByLoss(
  bestCp: number,
  playedCp: number,
  isBestMove: boolean,
  kind: GameKind = 'chess',
): MoveQuality {
  if (isBestMove) return 'best';
  const loss = Math.max(0, bestCp - playedCp);
  const t = LOSS_THRESHOLDS[kind];
  if (loss <= t.best) return 'best';
  if (loss <= t.good) return 'good';
  if (loss <= t.inaccuracy) return 'inaccuracy';
  if (loss <= t.mistake) return 'mistake';
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
 * @param kind        ゲーム種別。分類閾値の切替に使う。既定 'chess'（既存チェス呼び出しは無変更で動く）。
 */
export function buildExplanationContext(params: {
  fenBefore: string;
  movePlayed: string;
  bestScore: Score;
  bestMove: string;
  pv: string[];
  scoreAfter: Score;
  kind?: GameKind;
}): ExplanationContext {
  const { fenBefore, movePlayed, bestScore, bestMove, pv, scoreAfter, kind = 'chess' } = params;
  const playedScore = negateScore(scoreAfter); // 相手番視点 → 手番側視点へ
  const bestCp = scoreToCp(bestScore);
  const playedCp = scoreToCp(playedScore);
  const isBestMove = movePlayed === bestMove;
  const quality = classifyByLoss(bestCp, playedCp, isBestMove, kind);

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
