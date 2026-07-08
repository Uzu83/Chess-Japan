import type { Config } from 'shogiground/config';
import type { Color, DropDests, Key, MoveDests, PieceName } from 'shogiground/types';
import type { ShogiColor } from '../core/shogiPlayGame';

/*
 * shogiground 設定の共有モジュール（閲覧盤 ShogiBoard / 対局盤 ShogiPlayBoard 両方が使う）。
 *
 * WHY このモジュールに集約したか:
 *   (1) 見た目不変条件の「片肺退行」防止（2026-07-08 本番の見た目バグ再発防止・Codex ゲート②合意）。
 *       同じ不変条件が 2 つの盤に散らばると、片方だけ直して片方を直し忘れる事故が起きる
 *       （実際 Phase 4-1 で両盤とも scaleDownPieces を付け忘れて出荷した）。単一の const にまとめ、
 *       両盤が spread し、config ビルダを pure 関数として単体テスト(ShogiBoard.config.test.ts)で固定する。
 *   (2) config ビルダを component ファイルから出すことで react-refresh/only-export-components 警告を回避
 *       （このリポジトリの規約: 非 component の export は component ファイルに置かない。auth の authState.ts と同じ）。
 *   (3) usiToLastDests / splitSfen の重複を解消（以前は両盤に同じ実装があった）。
 */

/*
 * 両盤共有の視覚不変条件。
 *
 * scaleDownPieces: false —— 最重要。
 *   shogiground のデフォルトは true（公式サンプルは駒スプライトを 2マス幅で用意し scale(0.5) で
 *   1マスに収める前提）。本プロジェクトの shogiBoard.css は駒を 1マス幅(width:11.111%)の漢字グリフで
 *   描くため、true だと駒 transform が `translate(n*50%,..) scale(0.5)` になり、駒が半分サイズ＋
 *   translate 半分刻みで盤の左上 1/4 に凝縮される。棋譜/手番などの「状態」は正常なので状態検証だけでは
 *   気づけず、getBoundingClientRect の実測で判明した。CSS の「translate 100%=1マス」前提と対で必須。
 *   drag プレビュー(drag.ts)も同フラグを参照するので、false で対局中のドラッグ駒サイズも正しくなる。
 *
 * coordinates.enabled: false —— shogiground は coords.ranks/files（座標 DOM）を生成するが、本プロジェクトの
 *   shogiBoard.css は座標の配置スタイルを持たない（閲覧盤は元々 disabled のため未整備）。true だと座標が
 *   position:static で盤左上に「987654321…」と積み上がって駒に重なる（scaleDownPieces バグ修正後に顕在化）。
 *   棋譜パネルが日本語表記(☗７六歩)を出すので盤上座標は必須でない。将来スタイル付き座標が欲しくなったら
 *   shogiBoard.css に coords 配置を足して true に戻す。
 */
export const SHOGIGROUND_VISUAL_INVARIANTS = {
  scaleDownPieces: false,
  coordinates: { enabled: false },
} as const satisfies Partial<Config>;

/** chess UI の 'white'|'black' を shogiground の手番色に写す（先手=sente が下＝白相当）。 */
function toSgColor(orientation: 'white' | 'black'): Color {
  return orientation === 'black' ? 'gote' : 'sente';
}

/**
 * SFEN の盤面・持ち駒トークンを取り出す（shogiground の sfen.board / sfen.hands 用）。
 * 持ち駒トークン '-'（持ち駒なし）はそのまま渡してよい（shogiground は非駒文字を読み飛ばす）。
 * 対局盤の成りキャンセル時の盤リセットでも使うため export。
 */
export function splitSfenBoardHands(sfen: string): { board: string; hands: string } {
  const tokens = sfen.trim().split(/\s+/);
  return { board: tokens[0] ?? '', hands: tokens[2] ?? '-' };
}

/** SFEN を shogiground が要求する {board, hands, turn} に分解する。手番トークン 'b'=先手 / 'w'=後手。 */
function splitSfen(sfen: string): { board: string; hands: string; turn: Color } {
  const { board, hands } = splitSfenBoardHands(sfen);
  const tokens = sfen.trim().split(/\s+/);
  const turn: Color = tokens[1] === 'w' ? 'gote' : 'sente';
  return { board, hands, turn };
}

/**
 * USI 手を直前手ハイライト用の Key 配列に変換する。
 * - 通常手 "7g7f"  → ['7g','7f']（移動元・移動先）
 * - 成り   "7g7f+" → ['7g','7f']（末尾 '+' は無視）
 * - 打ち   "P*5e"  → ['5e']（打った先のみ。持ち駒からなので移動元マス無し）
 */
export function usiToLastDests(usi: string | null | undefined): Key[] {
  if (!usi) return [];
  if (usi.includes('*')) {
    // 打ち: '*' の後ろ 2 文字が打った先。
    const dest = usi.slice(usi.indexOf('*') + 1, usi.indexOf('*') + 3);
    return dest.length === 2 ? [dest as Key] : [];
  }
  if (usi.length >= 4) {
    return [usi.slice(0, 2) as Key, usi.slice(2, 4) as Key];
  }
  return [];
}

/** dropDests(role→to[]) を shogiground の DropDests(`${color} ${role}`→Key[]) へ変換する。 */
function toDropDests(dropDests: Map<string, string[]>, color: ShogiColor): DropDests {
  const out: DropDests = new Map();
  for (const [role, tos] of dropDests) {
    out.set(`${color} ${role}` as PieceName, tos as Key[]);
  }
  return out;
}

/** 閲覧盤(ShogiBoard)の config 入力。 */
export interface ShogiReviewConfigParams {
  sfen: string;
  /** 'white'=先手が下（既定）/ 'black'=後手が下。chess UI と語彙を合わせる。 */
  orientation?: 'white' | 'black';
  lastMoveUsi?: string | null;
}

/** 閲覧専用の将棋盤 config を組む pure 関数。 */
export function buildShogiReviewConfig(props: ShogiReviewConfigParams): Config {
  const orientation = props.orientation ?? 'white';
  const { board, hands, turn } = splitSfen(props.sfen);
  return {
    // 見た目不変条件は両盤で共有（scaleDownPieces:false / coordinates 無効）。
    ...SHOGIGROUND_VISUAL_INVARIANTS,
    sfen: { board, hands },
    turnColor: turn,
    orientation: toSgColor(orientation),
    // 閲覧専用: 操作・ドラッグ・描画レイヤを無効化（軽量化＆誤操作防止）。
    viewOnly: true,
    // 持ち駒を盤の上下にインラインで表示（別 DOM を渡さず shogiground に生成させる）。
    hands: { inlined: true },
    lastDests: usiToLastDests(props.lastMoveUsi),
    highlight: { lastDests: true },
    drawable: { enabled: false, visible: false },
  };
}

/** 対局盤(ShogiPlayBoard)の config 入力（state/props を平たく渡す。event は ref 越しのコールバック）。 */
export interface ShogiPlayConfigParams {
  sfen: string;
  orientation: ShogiColor;
  turnColor: ShogiColor;
  inCheck: boolean;
  lastMoveUsi: string | null;
  legalDests: Map<string, string[]>;
  dropDests: Map<string, string[]>;
  /** 人間が操作できるか（false で盤ロック）。 */
  movable: boolean;
  /**
   * events.after を config に含めるか。初期化時のみ true（set で毎回上書きすると多重登録の懸念）。
   * ※ event body は component 側で ref 越しに最新コールバックを呼ぶ（stale closure 回避）ため引数で受ける。
   */
  withEvents: boolean;
  onMoveAfter: (orig: Key, dest: Key) => void;
  onDropAfter: (piece: { role: string }, key: Key) => void;
}

/** 操作できる対局盤の shogiground config を組む pure 関数（値は component 内実装と同一。テスト可能化のため外出し）。 */
export function buildShogiPlayConfig(p: ShogiPlayConfigParams): Config {
  const { board, hands, turn } = splitSfen(p.sfen);
  // turn は使わない（対局は turnColor を明示で持つ）。board/hands のみ利用。
  void turn;
  return {
    // 見た目不変条件は両盤で共有（scaleDownPieces:false / coordinates 無効）。
    ...SHOGIGROUND_VISUAL_INVARIANTS,
    sfen: { board, hands },
    turnColor: p.turnColor as Color,
    orientation: p.orientation as Color,
    // 人間の手番のみ操作可能な色を渡す。ロック時(undefined)は盤も駒台も動かせない。
    activeColor: p.movable ? (p.turnColor as Color) : undefined,
    checks: p.inCheck ? (p.turnColor as Color) : false,
    lastDests: usiToLastDests(p.lastMoveUsi),
    highlight: { lastDests: true, check: true },
    hands: { inlined: true },
    animation: { enabled: true, duration: 200 },
    draggable: { enabled: true, showGhost: true },
    selectable: { enabled: true },
    movable: {
      free: false, // 合法手のみ
      dests: p.legalDests as MoveDests,
      showDests: true,
      ...(p.withEvents ? { events: { after: p.onMoveAfter } } : {}),
    },
    droppable: {
      free: false, // 合法な打ちのみ
      dests: toDropDests(p.dropDests, p.turnColor),
      showDests: true,
      ...(p.withEvents ? { events: { after: p.onDropAfter } } : {}),
    },
    // 内蔵の成りダイアログは使わない（自前ピッカーへ統一）。全経路で成りを自動発火させない。
    promotion: {
      movePromotionDialog: () => false,
      forceMovePromotion: () => false,
      dropPromotionDialog: () => false,
      forceDropPromotion: () => false,
    },
    drawable: { enabled: false, visible: false },
  };
}
