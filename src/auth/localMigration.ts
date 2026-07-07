/**
 * localMigration.ts — ローカルレートのクラウド移行提案ロジック(純関数)
 *
 * WHY 純関数として切り出すか:
 *   初回サインイン時に「localStorage のレートをクラウドへ引き継ぐか」の判定は
 *   副作用ゼロの純関数で書けるため vitest で完全にカバーできる。
 *   DB/SDK から切り離すことで、Supabase の認証フロー変更とは独立してテスト・
 *   ロジック変更できる。
 *
 * このモジュールは「提案するかどうかの判断」だけを行う。
 * 実際の移行(profiles.rating を UPDATE する API 呼び出し)は呼び出し側が担当する。
 */

import type { RatingData } from '../core/storage';
import { RATING_FLOOR, RATING_CEILING } from '../core/rating';

/**
 * ローカルレート移行の提案。
 *
 * kind='migrate' のときだけオンボーディングに「ローカルレートを引き継ぐ」選択肢を出す。
 * kind='none' のときは何もしない(デフォルトの初期レートか自己申告フローへ)。
 */
export type MigrationOffer =
  | {
      kind: 'migrate';
      /**
       * localStorage に保存されていた生のレート値(表示用)。
       * 天井/床クランプ前の値をユーザーに見せることで「3001 だったけど 3000 に丸めました」を
       * 正直に伝えられる。
       */
      localRating: number;
      /**
       * サーバーの check 制約 [RATING_FLOOR, RATING_CEILING] にクランプ済みの、
       * 実際に profiles.rating へ送る値。
       * WHY ここでクランプするか: 呼び出し側が「clampedRating をそのまま PUT/UPDATE すれば
       * 良い」という契約にし、check violation を呼び出し側に持ち込まない。
       */
      clampedRating: number;
      /** ローカルでのレート戦対局数(表示用。"○局分のレートを引き継ぎます" 等に使う)。 */
      games: number;
    }
  | { kind: 'none' };

/**
 * ローカルレートを元に移行提案を返す。
 *
 * @param local - localStorage から読んだ RatingData(無し・破損は null)。
 * @returns MigrationOffer - 移行するなら kind='migrate'、しないなら kind='none'。
 *
 * 判定ロジック:
 *   1. local === null → none（ローカルレート未保存 = 移行するものが無い）
 *   2. local.games <= 0 → none（1局も指していない初期値 1200 の移行は無意味。
 *      初期値ならむしろ自己申告オンボーディングの方が情報量がある）
 *   3. 非有限値(NaN/Infinity)が rating に含まれる → none（防衛的処理。
 *      storage.ts の deserializeRating は有限数を検証済みだが、
 *      移行は1回きりの不可逆操作なので「疑わしきは提案しない」に倒す）
 *   4. それ以外 → migrate。rating は Math.round 後に [RATING_FLOOR, RATING_CEILING] にクランプ。
 *
 * WHY マジックナンバーを使わないか:
 *   100 / 3000 を直書きすると rating.ts の RATING_FLOOR / RATING_CEILING との
 *   同期が取れなくなるリスクがある。import して参照することでサーバー check 制約との
 *   トリプルパリティ(server migration / rating.ts / この関数)を保つ。
 */
export function decideMigrationOffer(local: RatingData | null): MigrationOffer {
  // ── 1. ローカルデータなし ──────────────────────────────────
  if (local === null) {
    // ローカルストレージにレートが保存されていない = 移行するものが存在しない。
    return { kind: 'none' };
  }

  // ── 2. 対局数ゼロ(初期値のまま) ───────────────────────────
  if (local.games <= 0) {
    // 1局も指していない状態で初期値 1200 を引き継いでも情報量がない。
    // 初期値であれば自己申告(「チェス経験は?」のような質問)で設定する方が精度が高い。
    return { kind: 'none' };
  }

  // ── 3. 非有限値の防衛チェック ──────────────────────────────
  // storage.ts の deserializeRating は Number.isFinite を検証するが、
  // テストや将来の変更で非有限値が RatingData として渡される可能性をゼロにはできない。
  // 移行 = profiles.rating を書き換える 1 回きりの不可逆操作なので、
  // 疑わしいデータは「提案しない」に倒す。
  if (!Number.isFinite(local.rating) || !Number.isFinite(local.games)) {
    return { kind: 'none' };
  }

  // ── 4. 移行を提案 ─────────────────────────────────────────
  // rating は Math.round でまず整数化し、[RATING_FLOOR, RATING_CEILING] にクランプ。
  // WHY round か: localStorage 上は浮動小数で保存されることがある(delta 計算の中間値等)。
  // profiles.rating は integer 列なので、整数に揃えてから送る契約にする。
  // WHY round ではなく truncate でないか: 四捨五入が最もユーザーフレンドリー(1234.6→1235)。
  const rounded = Math.round(local.rating);
  const clampedRating = Math.min(RATING_CEILING, Math.max(RATING_FLOOR, rounded));

  return {
    kind: 'migrate',
    localRating: local.rating, // 生の値(表示用)
    clampedRating, // クランプ済み(サーバーへ送る値)
    games: local.games,
  };
}
