import type { GameKind } from '../core/types';

/*
 * evalLabel — 評価値(手番側視点の centipawn) → 表示用文字列。
 *
 * WHY component ファイル(ExplanationPanel.tsx)から出すか（react-refresh/only-export-components）:
 *   非 component の値 export を component ファイルに置くと Fast Refresh 警告になる（このリポジトリの規約。
 *   shogigroundConfig.ts と同じ理由）。単体テスト可能化も兼ねてここへ切り出す。
 */

/** 評価値(手番側視点) → 表示用文字列。+/-符号付き。
 *  WHY 詰みを「白詰み/黒詰み」と書かないか: この値は手番側視点であり、白視点ではない。
 *  黒の手の評価で cp>0 は「黒に詰みあり」なので、色を断定すると逆になる(実際に誤表示だった)。
 *  視点に依存しない「詰み(勝ち/負け)」で表現する。
 *
 *  WHY game で scale を分けるか（2026-07-09「将棋の評価がチェスのポーン換算で出る」対策）:
 *    チェスは「ポーン差」(cp/100=+0.4)が慣習。将棋のエンジン評価も centipawn だが、将棋界は
 *    生の評価値(+40 / +170 …ShogiGUI 等の表示)で読むのが慣習で、÷100 した "+0.4" は将棋では不自然。
 *    shogiNotation.shogiEvalText(ローカル解説の本文)も生評価値で出しており、パネルの数値表示だけ
 *    ポーン換算だと同一局面で "+0.4" と "+40" が混在して分かりにくい。よって将棋は生評価値、
 *    チェスはポーン換算に分ける。詰み(±99000 以上)の専用表現は両者共通(そのまま割ると巨大数が漏れる)。 */
export function evalLabel(cp: number | undefined, game: GameKind): string {
  if (cp === undefined) return '—';
  if (Math.abs(cp) >= 99000) return cp > 0 ? '詰み(勝ち)' : '詰み(負け)';
  const sign = cp > 0 ? '+' : '';
  // 将棋: 生の評価値(整数)。チェス: ポーン換算(小数1桁)。
  return game === 'shogi' ? `${sign}${cp}` : `${sign}${(cp / 100).toFixed(1)}`;
}
