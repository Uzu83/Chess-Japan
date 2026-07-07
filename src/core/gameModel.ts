/*
 * gameModel.ts — チェス/将棋を同じ振り返り UI に載せるための薄い共通読み取り面
 *
 * WHY この抽象を「今」作るか（Phase 4-1・Codex ゲート① 合意 #3）:
 *   Phase 4 で将棋を同居させるにあたり、選択肢は
 *     (a) ShogiReviewView を丸ごと別実装して後で共通化する（二重実装を一時許容）
 *     (b) 最初から薄い GameModel を挟んで ReviewView を 1 本に保つ
 *   の 2 案だった。ReviewView は解析ループ・キャッシュ・キーボードナビ・共有URL・自動解説など
 *   「ゲーム種別に依らないロジック」が大半を占める。これを二重化すると、片方だけ直してもう片方が
 *   腐る典型的な保守事故になる。よって (b) を採用し、"ChessGame/ShogiGame が満たす最小の読み取り面"
 *   だけをここに定義する。ChessGame(game.ts) は 1 行も触らず、薄いアダプタ chessGameModel() で包む。
 *
 * 設計の芯（なぜ moves を {label, engineMove} の2フィールドに絞るか）:
 *   ReviewView が本当に必要とするのは「人が読む表記(label)」と「エンジンに渡す座標(engineMove)」の2つ。
 *   チェスでは label=SAN / engineMove=UCI、将棋では label=日本語(☗７六歩) / engineMove=USI(7g7f)。
 *   fenBefore/fenAfter/color は fenAt() から機械的に導出できる（gameMoveRecords 参照）ので、
 *   モデル本体には持たせない＝重複と食い違いの芽を摘む。
 *
 * バンドル注意（1バイトも将棋をチェス利用者に払わせない不変条件）:
 *   このファイルはチェス経路(ReviewView→chessGameModel)から静的に読まれる＝メインチャンクに入る。
 *   よって **tsshogi を絶対に import しない**。将棋側の実装 shogiGameModel() は shogiGame.ts に置き、
 *   そちらは動的 import 経由でのみ到達させる（tsshogi は将棋チャンクに閉じ込める）。
 */

import type { ChessGame } from './game';
import type { GameKind, MoveRecord } from './types';

/**
 * 1手分の「表示用ラベル」と「エンジン用座標」。
 * - label:      人が読む表記。chess=SAN("Nf3") / shogi=日本語("☗７六歩")。
 * - engineMove: エンジンに渡す座標。chess=UCI("g1f3") / shogi=USI("7g7f" / "P*5e" / "7g7f+")。
 */
export interface GameMoveInfo {
  label: string;
  engineMove: string;
}

/**
 * ChessGame / ShogiGame が共通で満たす、振り返り UI 向けの最小読み取り面。
 * これ以上フィールドを増やさないこと（増やすとゲーム別実装の同期コストが上がる）。
 */
export interface GameModel {
  /** 'chess' | 'shogi'。UI 分岐（盤・エンジン・解説言語）とプロンプト言語切替に使う。 */
  readonly kind: GameKind;
  /** 開始局面。chess=FEN / shogi=SFEN。 */
  readonly startFen: string;
  /** 指し手列（先頭が初手）。 */
  readonly moves: readonly GameMoveInfo[];
  /**
   * 指定インデックスの局面表現（chess=FEN / shogi=SFEN）を返す。
   * index=0 は開始局面、index=k は k 手目を指した直後の局面。
   */
  fenAt(index: number): string;
  /** 対局結果（"投了" 等）。無ければ undefined。MVP では表示に必須ではない。 */
  readonly result?: string;
}

/**
 * FEN/SFEN の「手番」トークンから MoveRecord.color('w'|'b') を導く。
 *
 * WHY ここに置くか / なぜ将棋は反転するか（重要・地雷）:
 *   MoveRecord.color は元々チェス専用で、EvalBar/EvalGraph/MoveList は
 *   「color==='w' の手は基準側(白=盤下)視点」という前提で評価値を白視点へ揃えている。
 *   将棋では基準側(盤下)は先手。評価バーは "先手が上がると正" にしたい。
 *   SFEN の手番トークンは 'b'=先手(black/sente) / 'w'=後手(white/gote)。
 *   よって「先手が指す局面(SFEN 'b')」を color='w'(基準側=先手) に、
 *   「後手が指す局面(SFEN 'w')」を color='b' に **反転** して割り当てる。
 *   こうすると既存の白視点変換ロジック(formatMoveEval / normalizeEvalToWhiteCp)が
 *   そのまま "先手視点" として正しく働き、UI コンポーネントを 1 行も変えずに済む。
 *   （初手=先手=ply0 は color='w'→MoveList の「白」列＝先手が左に並ぶ、という自然な対応にもなる）
 */
export function sideToMove(fenOrSfen: string, kind: GameKind): 'w' | 'b' {
  const turn = fenOrSfen.split(/\s+/)[1] ?? 'w';
  if (kind === 'shogi') {
    // SFEN: 'b'(先手) → 基準側 'w' / 'w'(後手) → 'b'（上のコメントの反転規則）
    return turn === 'b' ? 'w' : 'b';
  }
  // chess: FEN の手番トークンがそのまま指し手のプレイヤー色
  return turn === 'b' ? 'b' : 'w';
}

/**
 * GameModel から、既存 UI コンポーネント(MoveList / EvalGraph / computeAccuracySummary)が
 * 期待する MoveRecord[] を機械的に再構築する。
 *
 * WHY MoveRecord を再構築するか（チェス回帰ゼロの肝）:
 *   MoveList/EvalGraph/evalUtils は元から MoveRecord[]（san/uci/fenBefore/fenAfter/color）を
 *   受け取る設計。ここで GameModel から同じ形を作り直せば、それらのコンポーネントを 1 行も
 *   変更せずにチェス・将棋の両方へ再利用できる。
 *   チェスでの同値性: chess.js 由来の連続局面では
 *     moves[k].fenBefore === fenAt(k) かつ moves[k].fenAfter === fenAt(k+1)
 *   が常に成り立つ（history の before/after は隣接手で連鎖する）ため、
 *   fenAt から再構築しても ChessGame.moves と完全に一致する（＝既存挙動不変）。
 */
export function gameMoveRecords(model: GameModel): MoveRecord[] {
  return model.moves.map((m, i) => {
    const fenBefore = model.fenAt(i);
    return {
      ply: i,
      san: m.label, // MoveList は m.san を表示するだけ＝将棋は日本語ラベルがそのまま出る
      uci: m.engineMove, // 「uci」名は歴史的。将棋では USI 文字列を格納（表示/エンジンとも文字列で等価）
      fenBefore,
      fenAfter: model.fenAt(i + 1),
      color: sideToMove(fenBefore, model.kind),
    };
  });
}

/**
 * ChessGame を GameModel に薄く適合させるアダプタ（ChessGame 本体は無改修）。
 *
 * WHY アダプタ方式か:
 *   game.ts(ChessGame) は Phase 0/1 から使われている「不変・振り返り用」の資産で、テストも厚い。
 *   ここを直接 GameModel 実装に書き換えるより、外から包む方が回帰リスクが低い（CLAUDE.md の
 *   「既存プロジェクトの不変条件を壊さない」姿勢に沿う）。
 */
export function chessGameModel(game: ChessGame): GameModel {
  return {
    kind: 'chess',
    startFen: game.startFen,
    // ChessGame.moves(MoveRecord[]) → GameMoveInfo に射影。label=SAN / engineMove=UCI。
    moves: game.moves.map((m) => ({ label: m.san, engineMove: m.uci })),
    fenAt: (index) => game.fenAt(index),
  };
}
