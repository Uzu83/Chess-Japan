/*
 * EvalBar — 縦型評価バー
 *
 * チェス棋譜レビューの定番 UI。白・黒それぞれの優勢度を棒の長さで示す。
 *
 * 慣習:
 *   - バー上端 = 黒側(暗色) / 下端 = 白側(淡色)  ← 盤の向き(白が下)と一致
 *   - 白有利 → 白(下)の割合が増える
 *   - 評価値は白視点(centipawn)。正=白有利、負=黒有利。
 *
 * 設計上の決定:
 *   - テキストラベルは付けない(12px 幅では読みにくい)。
 *     スクリーンリーダー向けに aria-label / aria-valuenow を付与。
 *     tooltip(title)でマウスユーザーも読めるようにする。
 *   - ±700cp で飽和(7枚の駒差=実質決着)。詰み値(±100000)も正しく飽和する。
 *   - motion-safe のみトランジションを付与(prefers-reduced-motion 対応)。
 *   - 色は eval-bar 専用(white=washi, black=sumi-ink)のため
 *     ライト/ダーク切替に依存しない固定値を使う。盤面の駒色と同じルール。
 */

import type { GameKind } from '../core/types';

interface EvalBarProps {
  /**
   * 白視点のセンチポーン評価値。
   * 正=白有利、負=黒有利、undefined=未解析(中立表示)。
   * scoreToCp 済みの値を渡すこと(詰みは ±100000 等の大きな値)。
   */
  evalCp?: number;
  /** ゲーム種別。詰みラベル（チェス=白/黒 / 将棋=先手/後手）に使う。既定 chess で従来挙動。 */
  game?: GameKind;
}

/** ±cp を [0, 1] の白割合に正規化。飽和ラインを 700cp に設定。 */
function toWhiteRatio(cp: number | undefined): number {
  if (cp === undefined) return 0.5;
  // Math.max/min で詰み値(±100000)を確実に飽和させる
  const clamped = Math.max(-700, Math.min(700, cp));
  return 0.5 + clamped / 700 / 2;
}

/** 評価値を人間向け文字列にフォーマット。tooltip / aria 用。詰みの手番ラベルは game 依存。 */
function formatCp(cp: number | undefined, game: GameKind): string {
  if (cp === undefined) return '解析中';
  if (Math.abs(cp) >= 99000) {
    // 詰み値(scoreToCp では 100000 - 手数)。手番ラベルはチェス=白/黒、将棋=先手/後手。
    const sign = cp > 0 ? (game === 'shogi' ? '先手' : '白') : game === 'shogi' ? '後手' : '黒';
    return `${sign}詰み`;
  }
  const sign = cp > 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(1)}`;
}

export function EvalBar({ evalCp, game = 'chess' }: EvalBarProps) {
  const whiteRatio = toWhiteRatio(evalCp);
  const whitePct = whiteRatio * 100;
  const blackPct = 100 - whitePct;
  const label = `評価: ${formatCp(evalCp, game)}`;

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={evalCp}
      aria-valuemin={-700}
      aria-valuemax={700}
      title={label}
      /* 幅は親コンテナで決める(w-3 = 12px が想定)。
         h-full: 親が flex-stretch で引き伸ばされる前提で高さを満たす。 */
      /* ring-1 + ring-washi-muted: バーを背景から浮かせる薄い枠線。
         WHY ring: washi(背景)と白セクションが同化しないよう境界を明示する。 */
      className="relative flex h-full w-full flex-col overflow-hidden rounded-sm ring-1 ring-washi-muted dark:ring-sumi-border"
    >
      {/* 黒セクション(上) — sumi-ink 固定色 */}
      <div className="w-full bg-sumi-ink" style={{ height: `${blackPct}%` }} aria-hidden="true" />

      {/* センター区切り線 — 互角を視覚的に示す細線 */}
      <div
        className="absolute left-0 right-0 h-px bg-washi-muted"
        style={{ top: '50%', transform: 'translateY(-50%)' }}
        aria-hidden="true"
      />

      {/* 白セクション(下) — 純白(#fff)
          WHY bg-white: bg-washi は背景色と同色のため見えない。
          motion-safe のみトランジション(prefers-reduced-motion 尊重)。   */}
      <div
        className="w-full bg-white motion-safe:transition-all motion-safe:duration-300"
        style={{ height: `${whitePct}%` }}
        aria-hidden="true"
      />
    </div>
  );
}
