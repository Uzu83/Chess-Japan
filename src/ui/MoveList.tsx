import type { MoveRecord, MoveQuality } from '../core/types';
import { qualityLabelJa } from '../core/classify';

/*
 * MoveList — 棋譜手順表
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
}

/** 棋譜の手をペア(白/黒)で表示し、クリックで局面へジャンプ。手の質バッジ付き。 */
export function MoveList({ moves, currentIndex, qualities, onSelect }: MoveListProps) {
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

    return (
      <button
        type="button"
        onClick={() => onSelect(ply + 1)}
        /* a11y: 手の内容と状態をラベルで伝える */
        aria-label={`${m.san}${q ? `（${qualityLabelJa(q)}）` : ''}${active ? '（現在の局面）' : ''}`}
        aria-pressed={active}
        className={[
          'focus-ai flex min-h-9 w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm transition-colors',
          active
            ? /* アクティブ: 藍サーフェス + 藍テキスト */
              'bg-ai-bg font-semibold text-ai'
            : 'text-on-surface hover:bg-surface-2',
        ].join(' ')}
      >
        {/* 手の表記 */}
        <span className="font-mono">{m.san}</span>

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
