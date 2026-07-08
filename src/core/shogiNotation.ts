/*
 * shogiNotation.ts — USI 座標 → 日本語表記(☗７六歩) 変換 と 将棋のローカル簡易解説
 *
 * WHY 別ファイル & 動的 import 前提か（1バイト不変条件の要）:
 *   このファイルは tsshogi に静的依存する。tsshogi(+将棋一式)をチェス利用者に払わせないため、
 *   ここへ到達する経路は **すべて動的 import** に限定する（explain/client.ts の将棋分岐、shogiGame.ts）。
 *   静的に import する側（メインチャンクに入る側）からは絶対に触らないこと。破ると tsshogi が
 *   メインバンドルへ漏れて「チェス利用者に 490KB を払わせる」不変条件違反になる。
 *
 * WHY エンジンは USI、表示は日本語か:
 *   やねうら王(USIプロトコル)は手を USI 座標("7g7f" / "P*5e" / "7g7f+")で返す。正確だが初心者には
 *   読めない。将棋の 1 手解説の価値は「☗７六歩(どの駒が・どこへ・成/打)」を日本語で示すことにある。
 *   tsshogi の formatMove(position, move) が公式の日本語表記(☗/☖ 付き)を返す（Phase 4-0 スパイクで
 *   往復一致を実測済み: usi_japanese_roundtrip PASS）。
 */

import { Position, formatMove } from 'tsshogi';
import type { ExplanationContext, MoveQuality } from './types';
import { qualityLabelJa } from './classify';

/**
 * ある局面(SFEN)における USI 1手を日本語表記に変換する。変換不能(不正SFEN/不正手)は null。
 *
 * 例: usiToJapanese(初期SFEN, "7g7f") === "☗７六歩"
 */
export function usiToJapanese(sfen: string, usi: string): string | null {
  const pos = Position.newBySFEN(sfen);
  if (!pos) return null;
  const move = pos.createMoveByUSI(usi);
  if (!move) return null;
  try {
    return formatMove(pos, move);
  } catch {
    // formatMove が想定外入力で投げても、UI を止めず null に統一（呼び出し側が USI へフォールバック）
    return null;
  }
}

/**
 * USI の読み筋(PV)を、開始 SFEN から順に適用して日本語表記の列に変換する。
 *
 * - maxPlies で表示用に打ち切る（PV は長くなりがち。UI には数手あれば筋が伝わる）。
 * - 途中で不正手/変換不能に当たったら、そこまでの列を返す（壊れた PV でも安全に部分表示）。
 *   この「部分的でも返す」方針は notation.ts(チェスの uciLineToSan) と揃えてある。
 */
export function usiLineToJapanese(sfen: string, usiMoves: string[], maxPlies = 6): string[] {
  const pos = Position.newBySFEN(sfen);
  if (!pos) return [];
  const out: string[] = [];
  for (let i = 0; i < usiMoves.length && i < maxPlies; i++) {
    const move = pos.createMoveByUSI(usiMoves[i]);
    if (!move) break;
    let jp: string | null;
    try {
      jp = formatMove(pos, move);
    } catch {
      break;
    }
    if (!jp) break;
    out.push(jp);
    // 次手を同じ局面上で表記するために局面を進める。doMove が false(非合法)なら打ち切る。
    if (!pos.doMove(move)) break;
  }
  return out;
}

/*
 * 詰み検出の閾値。classify.scoreToCp は詰みを ±(100000 - 手数) の巨大 cp に換算するため、
 * この値以上は「差」でなく「詰み」として表現する（client.ts の MATE_CP と同値・思想も同じ）。
 */
const MATE_CP = 99_000;

/**
 * 将棋の評価値(cp, 手番側視点)を人間向けの短い表現にする。
 *
 * WHY チェスの「ポーン換算」をそのまま使わないか:
 *   将棋のエンジン評価は centipawn 相当だが駒価値スケールが違い、"歩" は約 90〜100cp。
 *   「〜ポーン」という語はチェスの語彙なので、将棋では素の評価値(点)で示す方が誤解が少ない。
 *   詰みは専用表現にする（巨大 cp をそのまま割ると意味不明な数値が漏れる—チェス側で実際に起きたバグ）。
 */
function shogiEvalText(cp: number | undefined): string {
  if (cp === undefined) return '不明';
  if (Math.abs(cp) >= MATE_CP) return cp > 0 ? '詰みあり(勝ち)' : '詰まされる(負け)';
  const side = cp >= 0 ? '手番側有利' : '相手有利';
  // 評価値(点)をそのまま提示。歩得 ≈ +90 程度、という将棋の感覚に寄せる。
  return `${cp >= 0 ? '+' : ''}${cp}（${side}）`;
}

/**
 * バックエンド未設定時の将棋ローカル簡易解説（ルールベース・LLM 不要）。
 *
 * WHY client.ts の localExplanation(チェス)と分けるか:
 *   チェス版は同期関数で chess.js(既にメインバンドル)を使う。将棋版は tsshogi 依存なので、
 *   同期のチェス版に混ぜるとメインバンドルに tsshogi が漏れる。よって将棋の局所解説はここ
 *   (動的 import 到達専用モジュール)に置き、client.ts からは `await import` 経由で呼ぶ。
 *
 * 引数はフル ExplainRequest ではなく必要最小限(context/mode/question)に絞る:
 *   client.ts への循環 import を避け、このモジュールを解説言語ロジックとして独立させるため。
 */
export function localShogiExplanation(req: {
  context: ExplanationContext;
  mode: 'explain' | 'followup';
  question?: string;
}): string {
  const { context: c, mode, question } = req;
  if (mode === 'followup') {
    return `（ローカル簡易応答）「${question ?? ''}」について：現在の局面評価は ${shogiEvalText(
      c.evalAfter,
    )} です。詳しい対話解説にはAI解説バックエンドの設定が必要です。`;
  }

  const quality = c.quality ? qualityLabelJa(c.quality as MoveQuality) : '判定なし';

  // 最善手(USI)を日本語に変換して提示。変換失敗時は USI にフォールバックし情報を落とさない。
  let best: string;
  if (c.bestMove && c.movePlayed && c.bestMove !== c.movePlayed) {
    const bestJa = usiToJapanese(c.fenOrSfen, c.bestMove) ?? c.bestMove;
    const pvJa = c.pv ? usiLineToJapanese(c.fenOrSfen, c.pv, 6) : [];
    const line = pvJa.length > 0 ? `想定手順は ${pvJa.join(' ')}。` : '';
    let delta = '';
    if (c.evalBefore !== undefined && c.evalAfter !== undefined) {
      const isMateSwing = Math.abs(c.evalBefore) >= MATE_CP || Math.abs(c.evalAfter) >= MATE_CP;
      delta = isMateSwing
        ? 'この手は詰みに直結する重大な分岐でした。'
        : `評価差は約 ${c.evalBefore - c.evalAfter} 相当です。`;
    }
    best = `エンジンの最善手は ${bestJa} でした。${line}${delta}`;
  } else {
    best = 'これはエンジン最善手と一致します。';
  }

  return `この手は「${quality}」です。指す前の評価は ${shogiEvalText(
    c.evalBefore,
  )}、指した後は ${shogiEvalText(c.evalAfter)}。${best}（より自然な解説にはAI解説バックエンドの設定が必要です）`;
}
