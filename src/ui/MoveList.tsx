import type { MoveRecord, MoveQuality } from '../core/types';
import { qualityLabelJa } from '../core/classify';

const QUALITY_STYLE: Record<MoveQuality, string> = {
  best: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  good: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-200',
  inaccuracy: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  mistake: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200',
  blunder: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-200',
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
    if (!m) return <span className="text-slate-400">—</span>;
    const ply = m.ply;
    const active = currentIndex === ply + 1;
    const q = qualities[ply];
    return (
      <button
        onClick={() => onSelect(ply + 1)}
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-left text-sm hover:bg-slate-200 dark:hover:bg-slate-700 ${
          active ? 'bg-slate-300 font-semibold dark:bg-slate-600' : ''
        }`}
      >
        <span>{m.san}</span>
        {q && (
          <span className={`rounded px-1 text-[10px] ${QUALITY_STYLE[q]}`}>
            {qualityLabelJa(q)}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 lg:max-h-[420px]">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.no}
              className="border-b border-slate-100 last:border-0 dark:border-slate-800"
            >
              <td className="w-8 px-2 py-1 text-right text-slate-400">{r.no}.</td>
              <td className="px-1 py-1">{cell(r.white)}</td>
              <td className="px-1 py-1">{cell(r.black)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
