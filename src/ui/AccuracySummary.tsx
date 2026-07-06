import type { AccuracySummary, QualityCount } from '../core/evalUtils';
import { qualityLabelJa } from '../core/classify';
import type { MoveQuality } from '../core/types';

/*
 * AccuracySummary — 精度サマリ
 *
 * 解析済みの手から白/黒別に手の質分布を小さくまとめて表示する。
 *
 * 設計:
 *   - ゼロのカテゴリは表示しない(コンパクトに保つ)
 *   - 配色は MoveList / ExplanationPanel と同じ badge-* クラスを流用
 *   - 1手も解析されていなければ null を返して非表示(スロット不使用)
 *   - totalMoves は "解析済み/全手数" の表記に使う
 */

/** 表示対象の手質カテゴリ順(lichess 順: 良い→悪い)。 */
const ALL_QUALITIES: MoveQuality[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];

/** MoveQuality → badge-* Tailwind クラス名のマッピング(MoveList から流用)。 */
const QUALITY_BADGE: Record<MoveQuality, string> = {
  best: 'badge-best',
  good: 'badge-good',
  inaccuracy: 'badge-inaccuracy',
  mistake: 'badge-mistake',
  blunder: 'badge-blunder',
};

interface AccuracySummaryProps {
  summary: AccuracySummary;
  /** ゲームの総手数(解析済み割合の表示用)。 */
  totalMoves: number;
}

/**
 * 1色分(白 or 黒)のサマリ行。ゼロのカテゴリは省略する。
 */
function ColorRow({
  label,
  counts,
  total,
}: {
  label: string;
  counts: QualityCount;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="w-5 shrink-0 font-semibold text-muted">{label}</span>

      {ALL_QUALITIES.map((q) => {
        const count = counts[q];
        // ゼロは表示しない: 未達成カテゴリが並ぶと見づらい
        if (count === 0) return null;
        return (
          <span
            key={q}
            className={`rounded px-1.5 py-px leading-none ${QUALITY_BADGE[q]}`}
            aria-label={`${qualityLabelJa(q)} ${count}手`}
          >
            {qualityLabelJa(q)}&thinsp;{count}
          </span>
        );
      })}

      {/* 1手も解析されていない色は「未解析」と表示 */}
      {total === 0 && <span className="text-subtle">未解析</span>}
    </div>
  );
}

/**
 * 白/黒別に手の質分布を小さくサマリ表示するコンポーネント。
 * 解析済み手が 1 手もない場合は null(非表示)を返す。
 */
export function AccuracySummary({ summary, totalMoves }: AccuracySummaryProps) {
  const analyzedTotal = summary.whiteTotal + summary.blackTotal;
  // 1手も解析されていなければ表示しない
  if (analyzedTotal === 0) return null;

  return (
    <section
      aria-label="精度サマリ"
      className="rounded-xl border border-border bg-surface-2 px-3 py-2.5 shadow-card"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-on-surface">精度サマリ</h3>
        <span className="text-[10px] tabular-nums text-subtle">
          {analyzedTotal} / {totalMoves} 手解析済み
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <ColorRow label="白" counts={summary.white} total={summary.whiteTotal} />
        <ColorRow label="黒" counts={summary.black} total={summary.blackTotal} />
      </div>
    </section>
  );
}
