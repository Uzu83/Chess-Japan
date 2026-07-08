import { useEffect, useRef } from 'react';
import { Shogiground } from 'shogiground';
import type { Api } from 'shogiground/api';
import type { Config } from 'shogiground/config';
import type { Color, Key } from 'shogiground/types';
import './shogiBoard.css';

/*
 * ShogiBoard — shogiground をラップした閲覧専用の将棋盤（持ち駒表示込み）
 *
 * WHY 動的ロード前提か（1バイト不変条件）:
 *   このコンポーネントは ReviewView から React.lazy 経由で読み込まれる。static import すると
 *   shogiground がチェス利用者のメインバンドルに漏れる。将棋タブを開いたときだけ読ませる。
 *
 * WHY Board.tsx（chessground 版）と同じ「初期化1回 + api.set() 差分反映」パターンか:
 *   盤コンポーネントを毎レンダーで作り直すと重い＆アニメーションが飛ぶ。初期化は 1 回だけ行い、
 *   以降は SFEN / 向き / 直前手の変化を api.set() の差分で反映する（chessground 版と実装方針を統一）。
 *
 * 入力は SFEN（"lnsg... b - 1"）。盤面・持ち駒・手番を SFEN から切り出して shogiground に渡す。
 */

interface ShogiBoardProps {
  /** 表示する局面（SFEN）。 */
  sfen: string;
  /** 盤の向き。'white'=先手が下（既定）/ 'black'=後手が下。chess UI と語彙を合わせる。 */
  orientation?: 'white' | 'black';
  /** 直前の手（USI、例 "7g7f" / 打ちは "P*5e" / 成りは "7g7f+"）。ハイライトに使う。 */
  lastMoveUsi?: string | null;
}

/** chess UI の 'white'|'black' を shogiground の手番色に写す（先手=sente が下＝白相当）。 */
function toSgColor(orientation: 'white' | 'black'): Color {
  return orientation === 'black' ? 'gote' : 'sente';
}

/** SFEN 文字列を shogiground が要求する {board, hands, turn} に分解する。 */
function splitSfen(sfen: string): { board: string; hands: string; turn: Color } {
  const tokens = sfen.trim().split(/\s+/);
  const board = tokens[0] ?? '';
  // SFEN 手番トークン: 'b'=先手(sente) / 'w'=後手(gote)。
  const turn: Color = tokens[1] === 'w' ? 'gote' : 'sente';
  // 持ち駒トークン。'-'（持ち駒なし）はそのまま渡してよい（shogiground は非駒文字を読み飛ばす）。
  const hands = tokens[2] ?? '-';
  return { board, hands, turn };
}

/**
 * USI 手を直前手ハイライト用の Key 配列に変換する。
 * - 通常手 "7g7f"  → ['7g','7f']（移動元・移動先）
 * - 成り   "7g7f+" → ['7g','7f']（末尾 '+' は無視）
 * - 打ち   "P*5e"  → ['5e']（打った先のみ。持ち駒からなので移動元マス無し）
 */
function usiToLastDests(usi: string | null | undefined): Key[] {
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

/**
 * 現在の props から shogiground 設定を組む（初期化・更新で共用）。
 * export している理由: 見た目バグ(scaleDownPieces)の回帰を単体テストで固定するため
 * （ShogiBoard.config.test.ts）。jsdom はレイアウトを計算しないので描画自体はテストできないが、
 * 「設定値が正しいこと」だけは pure 関数として検証できる。
 */
export function buildConfig(props: ShogiBoardProps): Config {
  const orientation = props.orientation ?? 'white';
  const { board, hands, turn } = splitSfen(props.sfen);
  return {
    sfen: { board, hands },
    turnColor: turn,
    orientation: toSgColor(orientation),
    // 【CRITICAL・見た目バグ再発防止 / 2026-07-08 本番で発覚】必ず false。
    //   shogiground のデフォルトは scaleDownPieces:true（公式サンプルは駒スプライトを 2マス幅で
    //   用意し scale(0.5) で 1マスに収める前提）。true だと駒 transform が
    //   `translate(n*50%,..) scale(0.5)` になり translate も半分刻みになる。
    //   本プロジェクトの shogiBoard.css は駒を 1マス幅(width:11.111%)の漢字グリフで描くため、
    //   true のままだと駒が半分サイズ＋半分刻みで盤の左上 1/4 に凝縮される
    //   （Phase 4-1 から潜伏。棋譜/手番は正常なので状態検証では気づけず getBoundingClientRect で判明）。
    //   CSS の「translate 100%=1マス」前提と対で必須。ShogiPlayBoard.tsx にも同じ設定あり。
    scaleDownPieces: false,
    // 閲覧専用: 操作・ドラッグ・描画レイヤを無効化（軽量化＆誤操作防止）。
    viewOnly: true,
    coordinates: { enabled: false },
    // 持ち駒を盤の上下にインラインで表示（別 DOM を渡さず shogiground に生成させる）。
    hands: { inlined: true },
    lastDests: usiToLastDests(props.lastMoveUsi),
    highlight: { lastDests: true },
    drawable: { enabled: false, visible: false },
  };
}

/** shogiground を React でラップした閲覧用の将棋盤（レスポンシブ・持ち駒つき）。 */
export function ShogiBoard(props: ShogiBoardProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    // wrapElements.board に div を渡すと、この div が .sg-wrap になり内部に盤・持ち駒が生える。
    apiRef.current = Shogiground(buildConfig(props), { board: elRef.current });
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // 初期化は一度だけ。以降の更新は下の effect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.set(buildConfig(props));
    // props（sfen/orientation/lastMoveUsi）変化のたびに差分反映。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sfen, props.orientation, props.lastMoveUsi]);

  return <div ref={elRef} className="w-full" />;
}
