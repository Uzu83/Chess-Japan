/**
 * localMigration.test.ts — decideMigrationOffer の全分岐テスト
 *
 * 対象: src/auth/localMigration.ts
 * 純関数なので外部依存なし・モック不要。
 *
 * カバーする分岐:
 *   - null → none
 *   - games=0 → none
 *   - games>0, 正常値 → migrate(値そのまま)
 *   - rating が下限未満 → clampedRating が RATING_FLOOR に補正
 *   - rating が上限超 → clampedRating が RATING_CEILING に補正
 *   - rating が小数 → clampedRating は Math.round 後にクランプ
 *   - NaN → none
 *   - Infinity → none
 */

import { describe, it, expect } from 'vitest';
import { decideMigrationOffer } from './localMigration';
import type { RatingData } from '../core/storage';
import { RATING_FLOOR, RATING_CEILING } from '../core/rating';

// ── ヘルパー ──────────────────────────────────────────────────────
// RatingData を手軽に作るヘルパー。型キャストを一ヶ所に集め、
// 非有限値テストで明示的に型を破る箇所を分かりやすくする。
function makeLocal(rating: number, games: number): RatingData {
  return { rating, games };
}

// ── テストスイート ───────────────────────────────────────────────

describe('decideMigrationOffer', () => {
  // ── none になるケース ──────────────────────────────────────────

  it('local が null のとき none を返す', () => {
    // ローカルストレージにレートが保存されていない状態。移行するものが無い。
    expect(decideMigrationOffer(null)).toEqual({ kind: 'none' });
  });

  it('games が 0 のとき none を返す', () => {
    // 1局も指していない初期値(games=0)は移行する意味がない。
    // 自己申告オンボーディングの方が情報量が高い。
    const local = makeLocal(1200, 0);
    expect(decideMigrationOffer(local)).toEqual({ kind: 'none' });
  });

  it('games が負のときも none を返す', () => {
    // 負の対局数は通常起きないが防衛的に none へ倒す。
    // (games <= 0 チェックが負も含む)
    const local = makeLocal(1200, -1);
    expect(decideMigrationOffer(local)).toEqual({ kind: 'none' });
  });

  it('rating が NaN のとき none を返す', () => {
    // 移行は 1 回きりの不可逆操作。非有限値は疑わしきは提案しない。
    // storage.ts の deserializeRating は有限数を検証するが、
    // テストや将来の変更でこのパスを通る可能性をゼロにはできないので防衛チェックを置く。
    const local = makeLocal(NaN, 10);
    expect(decideMigrationOffer(local)).toEqual({ kind: 'none' });
  });

  it('rating が Infinity のとき none を返す', () => {
    const local = makeLocal(Infinity, 10);
    expect(decideMigrationOffer(local)).toEqual({ kind: 'none' });
  });

  it('rating が -Infinity のとき none を返す', () => {
    const local = makeLocal(-Infinity, 10);
    expect(decideMigrationOffer(local)).toEqual({ kind: 'none' });
  });

  // ── migrate になるケース ───────────────────────────────────────

  it('games > 0 かつ有限な rating のとき migrate を返す(値そのまま)', () => {
    // 正常な移行候補。clampedRating は [RATING_FLOOR, RATING_CEILING] 内に収まる。
    const local = makeLocal(1500, 20);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.localRating).toBe(1500); // 生の値を保持
      expect(offer.clampedRating).toBe(1500); // クランプ不要なので変化なし
      expect(offer.games).toBe(20);
    }
  });

  it('rating が 50(下限 RATING_FLOOR 未満)のとき clampedRating が RATING_FLOOR にクランプされる', () => {
    // 50 → Math.round(50)=50 → max(RATING_FLOOR=100, 50)=100
    // localRating は生の値(50)で保持し、送る値(clampedRating)だけ補正する。
    const local = makeLocal(50, 5);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.localRating).toBe(50); // 生の値はそのまま表示用に保持
      expect(offer.clampedRating).toBe(RATING_FLOOR); // 100 にクランプ
      expect(offer.games).toBe(5);
    }
  });

  it('rating が 5000(上限 RATING_CEILING 超)のとき clampedRating が RATING_CEILING にクランプされる', () => {
    // 5000 → Math.round(5000)=5000 → min(RATING_CEILING=3000, 5000)=3000
    const local = makeLocal(5000, 30);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.localRating).toBe(5000);
      expect(offer.clampedRating).toBe(RATING_CEILING); // 3000 にクランプ
      expect(offer.games).toBe(30);
    }
  });

  it('rating が小数(1234.6)のとき clampedRating は四捨五入される', () => {
    // 1234.6 → Math.round(1234.6)=1235 → クランプ不要(100〜3000 内)
    // profiles.rating は integer 列なので round してから送る契約。
    const local = makeLocal(1234.6, 15);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.localRating).toBe(1234.6); // 表示用は生の値
      expect(offer.clampedRating).toBe(1235); // round 後の整数
      expect(offer.games).toBe(15);
    }
  });

  it('rating が小数かつ下限未満(99.4)のとき round 後にクランプされる', () => {
    // 99.4 → Math.round(99.4)=99 → max(RATING_FLOOR=100, 99)=100
    // round → clamp の順序を確認する境界値テスト。
    const local = makeLocal(99.4, 3);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.localRating).toBe(99.4);
      expect(offer.clampedRating).toBe(RATING_FLOOR); // 100
    }
  });

  it('rating がちょうど RATING_FLOOR(100)のとき変化なし', () => {
    const local = makeLocal(RATING_FLOOR, 1);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.clampedRating).toBe(RATING_FLOOR);
    }
  });

  it('rating がちょうど RATING_CEILING(3000)のとき変化なし', () => {
    const local = makeLocal(RATING_CEILING, 50);
    const offer = decideMigrationOffer(local);
    expect(offer.kind).toBe('migrate');
    if (offer.kind === 'migrate') {
      expect(offer.clampedRating).toBe(RATING_CEILING);
    }
  });
});
