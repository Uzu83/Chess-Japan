import type { MoveQuality } from './types';

/**
 * 「次のミスへ」ジャンプ用。
 *
 * qualities のキーは ply（0始まり）。返り値は盤の index（0=開始局面、k=k手目直後）。
 * currentIndex より後の mistake/blunder を探し、無ければ先頭のミスへラップする。
 * ミスが1手も無ければ null。
 *
 * WHY inaccuracy を含めないか:
 *   「ミスへ飛ぶ」期待は失点の大きい手。不正確まで入れると連打感が薄れる。
 */
const MISS_QUALITIES: ReadonlySet<MoveQuality> = new Set(['mistake', 'blunder']);

export function findNextMissIndex(
  qualities: Record<number, MoveQuality | undefined>,
  currentIndex: number,
): number | null {
  const missPlies = Object.keys(qualities)
    .map(Number)
    .filter((ply) => {
      const q = qualities[ply];
      return q !== undefined && MISS_QUALITIES.has(q);
    })
    .sort((a, b) => a - b);

  if (missPlies.length === 0) return null;

  const after = missPlies.find((ply) => ply + 1 > currentIndex);
  if (after !== undefined) return after + 1;
  return missPlies[0]! + 1;
}
