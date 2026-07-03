import { useEffect, useRef } from 'react';
import type { MoveRecord, MoveQuality, ExplanationContext } from '../core/types';
import { qualityLabelJa } from '../core/classify';
import { formatMoveEval } from '../core/evalUtils';

/*
 * MoveList — 棋譜手順表
 *
 * 強化点(2025-07以降):
 *   - contexts prop を追加し、解析済みの手に評価値(白視点 "+1.2" 等)を小さく併記。
 *     formatMoveEval で手番色を考慮して白視点に揃える。
 *   - currentIndex が変わると自動スクロール(keyboard / グラフジャンプ時も対応)。
 *     data-ply 属性でターゲットを特定し scrollIntoView({ block: 'nearest' }) で実行。
 *     behavior: 'smooth' でジャンプを緩やかに。
 *
 * 手の質バッジ:
 *   badge-* クラスで index.css の CSS 変数を参照。
 *   ライト/ダーク自動切替。コンポーネント側に dark: を書かない(「真実の源」集約)。
 *   色相は lichess 準拠(best=藍, good=緑青, inaccuracy=黄土, mistake=柿, blunder=朱)。
 *
 * 現在手ハイライト:
 *   bg-ai-bg text-ai で藍サーフェスをアクティブ状態として使う。
 *   他手とのコントラストを確保しつつ世界観に統一する。
 *
 * タップ領域:
 *   各セルボタンは min-h-9 (36px)。モバイルで 2 カラム表示される手順表内では
 *   36px でも誤タップは起きにくい(隣接セルとの余白あり)。
 */

const QUALITY_BADGE: Record<MoveQuality, string> = {
  best: 'badge-best',
  good: 'badge-good',
  inaccuracy: 'badge-inaccuracy',
  mistake: 'badge-mistake',
  blunder: 'badge-blunder',
};

interface MoveListProps {
  moves: MoveRecord[];
  currentIndex: number; // 0=開始局面, k=k手目直後
  qualities: Record<number, MoveQuality | undefined>;
  onSelect: (index: number) => void;
  /**
   * 解析済みコンテキスト。キー=ply(0始まり)。
   * 渡された場合、各手の隣に評価値(白視点)を小さく表示する。
   */
  contexts?: Record<number, ExplanationContext>;
}

/** 棋譜の手をペア(白/黒)で表示し、クリックで局面へジャンプ。手の質バッジ付き。 */
export function MoveList({ moves, currentIndex, qualities, onSelect, contexts }: MoveListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // ── 自動スクロール ─────────────────────────────────────────
  // currentIndex が変わるたびに(keyboard ナビや EvalGraph クリック経由も含む)
  // アクティブな手のセルを可視域にスクロールする。
  //
  // WHY data-ply 属性か:
  //   aria-pressed を使って querySelector することも可能だが、
  //   data-ply の方が意図が明確で、アクティブ状態の変更と独立している。
  useEffect(() => {
    if (currentIndex < 1) return;
    const ply = currentIndex - 1;
    const el = listRef.current?.querySelector(`[data-ply="${ply}"]`);
    if (!el) return;
    // prefers-reduced-motion を尊重(reviewer M-2)。本リポは motion-safe: 方針なのでスムーススクロールも従わせる。
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // block:'nearest' で「見えていれば動かさない・必要最小限だけ動かす」→ 祖先(ページ)ジャンプを抑制。
    el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [currentIndex]);

  const rows: { no: number; white?: MoveRecord; black?: MoveRecord }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ no: i / 2 + 1, white: moves[i], black: moves[i + 1] });
  }

  const cell = (m?: MoveRecord) => {
    if (!m)
      return (
        <span className="px-2 py-1 text-sm text-subtle" aria-hidden="true">
          —
        </span>
      );

    const ply = m.ply;
    const active = currentIndex === ply + 1;
    const q = qualities[ply];
    const ctx = contexts?.[ply];

    // 評価値テキスト(白視点、手番色を考慮して変換)
    // WHY formatMoveEval に color を渡すか:
    //   evalAfter は「指したプレイヤー視点」。黒が指した後は符号反転して白視点に揃える。
    //   display 値は "+1.2" や "-0.5"、詰み時は "+M" / "-M"。
    const evalText = ctx?.evalAfter !== undefined ? formatMoveEval(ctx.evalAfter, m.color) : null;

    return (
      <button
        type="button"
        onClick={() => onSelect(ply + 1)}
        data-ply={ply}
        /* a11y: 手の内容と状態をラベルで伝える */
        aria-label={`${m.san}${q ? `（${qualityLabelJa(q)}）` : ''}${evalText ? `（評価${evalText}）` : ''}${active ? '（現在の局面）' : ''}`}
        aria-pressed={active}
        className={[
          'focus-ai flex min-h-9 w-full items-center gap-1 rounded px-2 py-1 text-left text-sm transition-colors',
          active
            ? /* アクティブ: 藍サーフェス + 藍テキスト */
              'bg-ai-bg font-semibold text-ai'
            : 'text-on-surface hover:bg-surface-2',
        ].join(' ')}
      >
        {/* 手の表記 */}
        <span className="font-mono">{m.san}</span>

        {/* 評価値: 小さく・控えめ色。解析済みの手にのみ表示。
            WHY tabular-nums: 数字の幅が変わって左右にブレないように固定幅。 */}
        {evalText && (
          <span
            className={[
              'shrink-0 font-mono text-[10px] tabular-nums',
              active ? 'text-ai opacity-70' : 'text-subtle',
            ].join(' ')}
            aria-hidden="true" // ラベルに含めているので重複して読み上げない
          >
            {evalText}
          </span>
        )}

        {/* 手の質バッジ: badge-* で CSS 変数自動切替 */}
        {q && (
          <span
            className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-none ${QUALITY_BADGE[q]}`}
          >
            {qualityLabelJa(q)}
          </span>
        )}
      </button>
    );
  };

  return (
    /* max-h で溢れたらスクロール。lg でさらに深く。 */
    <div
      ref={listRef}
      role="list"
      aria-label="棋譜手順"
      className="max-h-64 overflow-auto rounded-xl border border-border lg:max-h-[440px]"
    >
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.no} className="border-b border-border last:border-0">
              {/* 手番号: subtle で控えめに */}
              <td className="w-8 px-2 py-0.5 text-right text-xs tabular-nums text-subtle select-none">
                {r.no}.
              </td>
              <td className="px-0.5 py-0.5">{cell(r.white)}</td>
              <td className="px-0.5 py-0.5">{cell(r.black)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
