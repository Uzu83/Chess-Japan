import type { ExplanationContext, MoveQuality, MoveRecord } from './types';

// ── 評価値フォーマット ─────────────────────────────────────────

/**
 * 白視点センチポーン(生値・クランプなし)を表示用の短い文字列に変換する。
 *
 * WHY 99000 の閾値:
 *   scoreToCp(mate:1) = 99999, scoreToCp(mate:2) = 99998 ...
 *   scoreToCp(mate:100) = 99900。実用上の詰み値はすべて 99000 以上になる。
 *   通常の棋譜で |evalAfter| が 99000 以上になるのは詰み以外にない。
 *
 * 用途: MoveList の評価列・EvalGraph ツールチップ。
 *
 * @param whiteCp 白視点センチポーン(正=白有利 / 負=黒有利)
 */
export function formatEvalCp(whiteCp: number): string {
  if (whiteCp >= 99000) return '+M';
  if (whiteCp <= -99000) return '-M';
  const pawns = whiteCp / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
}

/**
 * ExplanationContext の evalAfter と手番色から白視点の表示文字列を返す。
 *
 * evalAfter は「指したプレイヤー視点」のため、黒が指した後は符号反転して白視点に揃える。
 * normalizeEvalToWhiteCp と同じ変換だが、GRAPH_CLAMP_CP でクランプしない
 * (詰み値の検出を正確に行うため)。
 *
 * @param evalAfter ExplanationContext.evalAfter の値(手番側視点 cp)
 * @param color     手を指したプレイヤー
 */
export function formatMoveEval(evalAfter: number, color: 'w' | 'b'): string {
  const whiteCp = color === 'w' ? evalAfter : -evalAfter;
  return formatEvalCp(whiteCp);
}

/**
 * グラフ描画における評価値の飽和上限(cp)。
 *
 * WHY 1000cp: EvalBar の 700cp より広く取る理由は、グラフでは「詰み寸前の急落」
 * を視覚的に強調したいため。±700cp だとグラフ上端/下端にすぐ張り付いて、
 * その後の緩やかな変化が潰れて見えなくなる。
 * 詰み値(±99000 等)はどちらにせよここで飽和するため、グラフ外に飛び出ない。
 */
export const GRAPH_CLAMP_CP = 1000;

/**
 * ExplanationContext の evalAfter を白視点(white-perspective)の cp に正規化する。
 *
 * WHY この関数が必要か:
 *   buildExplanationContext 内で evalAfter = negateScore(scoreAfter).cp
 *   = 「指したプレイヤー視点」の評価値。
 *   - 白が指した後: evalAfter > 0 = 白有利 → そのまま白視点
 *   - 黒が指した後: evalAfter > 0 = 黒有利 → 白視点にするには符号反転
 *
 *   同じ変換が ReviewView.tsx の evalCpWhite 計算でも使われているが、
 *   純関数として切り出すことでグラフコンポーネントとテストから再利用できる。
 *
 * @param evalAfter - ExplanationContext.evalAfter の値
 * @param color     - 手を指したプレイヤー ('w' | 'b')
 * @returns 白視点 cp。[-GRAPH_CLAMP_CP, +GRAPH_CLAMP_CP] に収まることを保証。
 */
export function normalizeEvalToWhiteCp(evalAfter: number, color: 'w' | 'b'): number {
  // 黒番の evalAfter は「黒有利が正」なので反転して白視点に揃える
  const whiteCp = color === 'w' ? evalAfter : -evalAfter;
  // 詰み値(±99000 等)がグラフ外に飛び出ないようクランプ
  return Math.max(-GRAPH_CLAMP_CP, Math.min(GRAPH_CLAMP_CP, whiteCp));
}

/** 各手の質の件数をカテゴリ別に保持する型。 */
export type QualityCount = Record<MoveQuality, number>;

/**
 * 白/黒別の手の質集計結果。
 * whiteTotal / blackTotal は解析済み手数(= quality が確定している手数)。
 */
export interface AccuracySummary {
  white: QualityCount;
  black: QualityCount;
  /** 白の解析済み手数 */
  whiteTotal: number;
  /** 黒の解析済み手数 */
  blackTotal: number;
}

/** ゼロ初期化した QualityCount を返す。 */
function emptyCount(): QualityCount {
  return { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

/**
 * 解析済みコンテキストから白/黒別に手の質を集計する純関数。
 *
 * WHY 純関数に切り出すか:
 *   ReviewView の useMemo 内でも使えるが、独立した純関数にすることで
 *   単体テストが書けて正規化ロジックの回帰検知が容易になる。
 *
 * @param contexts - 解析済みコンテキスト。キー=ply(0始まり)。未解析は欠落。
 * @param moves    - 棋譜全手(ply → color を解決するために使う)
 */
export function computeAccuracySummary(
  contexts: Record<number, ExplanationContext>,
  moves: MoveRecord[],
): AccuracySummary {
  const summary: AccuracySummary = {
    white: emptyCount(),
    black: emptyCount(),
    whiteTotal: 0,
    blackTotal: 0,
  };

  for (const [plyStr, ctx] of Object.entries(contexts)) {
    const ply = Number(plyStr);
    const move = moves[ply];
    // quality が未設定(解析エラー等)は集計しない
    if (!move || !ctx.quality) continue;

    if (move.color === 'w') {
      summary.white[ctx.quality]++;
      summary.whiteTotal++;
    } else {
      summary.black[ctx.quality]++;
      summary.blackTotal++;
    }
  }

  return summary;
}
