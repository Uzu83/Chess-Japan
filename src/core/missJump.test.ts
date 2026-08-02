import { describe, expect, it } from 'vitest';
import { findNextMissIndex } from './missJump';
import type { MoveQuality } from './types';

function q(map: Record<number, MoveQuality>): Record<number, MoveQuality | undefined> {
  return map;
}

describe('findNextMissIndex', () => {
  it('returns null when no mistakes', () => {
    expect(findNextMissIndex(q({ 0: 'best', 1: 'good' }), 0)).toBeNull();
  });

  it('finds the first miss after current index', () => {
    const qualities = q({ 1: 'good', 3: 'mistake', 7: 'blunder' });
    expect(findNextMissIndex(qualities, 0)).toBe(4); // ply 3 → index 4
    expect(findNextMissIndex(qualities, 4)).toBe(8); // ply 7 → index 8
  });

  it('wraps to the first miss when past the last', () => {
    const qualities = q({ 2: 'blunder', 5: 'mistake' });
    expect(findNextMissIndex(qualities, 6)).toBe(3);
  });

  it('ignores inaccuracy', () => {
    expect(findNextMissIndex(q({ 2: 'inaccuracy', 4: 'mistake' }), 0)).toBe(5);
  });
});
