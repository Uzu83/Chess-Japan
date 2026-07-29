/*
 * boardContext.ts — フィードバック用の「いま見えている局面」スナップショット
 *
 * WHY グローバル弱参照か:
 *   FeedbackDialog は App シェルにあり、PlayView/ReviewView の fen を props で渡すと
 *   配線が太い。対局/レビューが更新するたびにここへ書くだけで、ダイアログ open 時に読める。
 *   秘密は載せない（FEN/SFEN のみ）。未設定なら UI は空欄のまま。
 */

export type FeedbackBoardSnapshot = {
  game: 'chess' | 'shogi';
  /** チェス=FEN / 将棋=SFEN */
  position: string;
};

let latest: FeedbackBoardSnapshot | null = null;

export function setFeedbackBoardContext(snap: FeedbackBoardSnapshot | null): void {
  latest = snap;
}

export function getFeedbackBoardContext(): FeedbackBoardSnapshot | null {
  return latest;
}

/** ダイアログの「局面」欄向けの初期文字列。 */
export function formatFeedbackBoardPaste(snap: FeedbackBoardSnapshot | null): string {
  if (!snap?.position?.trim()) return '';
  return snap.position.trim();
}
