/*
 * shogiGame.ts — 将棋の棋譜文字列(KIF/KI2/CSA/JKF/USI/SFEN)を GameModel に変換する
 *
 * WHY 動的 import 到達専用か（1バイト不変条件）:
 *   このファイルは tsshogi に静的依存する。チェス利用者に将棋一式(tsshogi ~ shogiground ~ やねうら王)を
 *   1バイトも払わせない不変条件を守るため、ここへの到達は **必ず動的 import**（ReviewView の将棋分岐で
 *   `await import('../core/shogiGame')`）に限定する。メインチャンクから静的に import してはならない。
 *
 * WHY tsshogi 単体で棋譜層をまかなうか（Codex ゲート① 決定 #1）:
 *   Phase 4-0 スパイクで tsshogi のルール完全性 6/6 PASS を実測（KIF→SFEN 各手・打ち歩詰め・千日手・
 *   持将棋・USI↔日本語往復）。shogiops は千日手/持将棋 API が無く優位性なしと判定。よって将棋の
 *   「棋譜/局面/表記」層は tsshogi 単体に一本化する。
 *
 * 設計: 棋譜文字列 → tsshogi.Record → メインラインを走査して
 *   startFen(初期SFEN) / 各手の USI(engineMove) / 各手の日本語表記(label) / 各局面SFEN を取り出し、
 *   GameModel（gameModel.ts の共通読み取り面）として返す。ReviewView はこの GameModel だけを見る。
 */

import {
  Record,
  Position,
  Move,
  formatMove,
  formatSpecialMove,
  detectRecordFormat,
  RecordFormatType,
  importKIF,
  importKI2,
  importCSA,
  importJKFString,
} from 'tsshogi';
import type { GameModel, GameMoveInfo } from './gameModel';

/** formatMove を例外安全にする（想定外入力で UI を止めない）。失敗は null。 */
function safeFormatMove(pos: Position, move: Move): string | null {
  try {
    return formatMove(pos, move);
  } catch {
    return null;
  }
}

/** 指定フォーマットで 1 回だけ読み込みを試す。成否は Record | Error で返す。 */
function importByFormat(text: string, fmt: RecordFormatType): Record | Error {
  switch (fmt) {
    case RecordFormatType.KIF:
      return importKIF(text);
    case RecordFormatType.KI2:
      return importKI2(text);
    case RecordFormatType.CSA:
      return importCSA(text);
    case RecordFormatType.JKF:
      return importJKFString(text);
    case RecordFormatType.USI:
      // "startpos moves ..." / "sfen ... moves ..." を受ける。
      return Record.newByUSI(text.trim());
    case RecordFormatType.SFEN: {
      // 単一局面の SFEN（指し手なし）。局面だけ表示できるよう 0 手の Record を作る。
      const pos = Position.newBySFEN(text.trim());
      return pos ? new Record(pos) : new Error('SFEN を解釈できませんでした');
    }
    default:
      return new Error('未対応の棋譜フォーマットです');
  }
}

/**
 * 棋譜文字列を Record に変換する。detectRecordFormat の推定を先頭に、外れたときのための
 * フォールバック順で総当たりする。
 *
 * WHY フォールバックするか:
 *   detectRecordFormat は「一部の文字並び・頻度による簡易判定」で、フォーマット準拠を保証しない
 *   （tsshogi 公式コメント）。貼り付けテキストの揺れ（ヘッダ欠落・全角半角混在等）で誤判定しても、
 *   代表フォーマットを順に試せば正しく読めることが多い。全部失敗して初めてエラーにする。
 */
function importRecord(text: string): Record {
  const detected = detectRecordFormat(text);
  // 推定を先頭に、実運用で貼られやすい代表フォーマットを続ける（重複は除外）。
  const order: RecordFormatType[] = [
    detected,
    RecordFormatType.KIF,
    RecordFormatType.KI2,
    RecordFormatType.CSA,
    RecordFormatType.USI,
    RecordFormatType.SFEN,
    RecordFormatType.JKF,
  ].filter((f, i, arr) => arr.indexOf(f) === i);

  let lastErr: Error | null = null;
  for (const fmt of order) {
    const r = importByFormat(text, fmt);
    if (!(r instanceof Error)) return r;
    lastErr = r;
  }
  throw lastErr ?? new Error('棋譜を解釈できませんでした');
}

/**
 * 将棋の棋譜文字列から GameModel を構築する（唯一の公開エントリ）。
 *
 * @throws 解釈不能な棋譜のときにエラー（呼び出し側 ReviewView が UI にエラー表示する）。
 */
export function shogiGameModel(text: string): GameModel {
  const record = importRecord(text);

  // メインラインを 0 手目(初期局面)から辿る。
  record.goto(0);
  const startFen = record.position.sfen;
  // sfens[k] = k 手目を指した直後の局面 SFEN。sfens[0] = 初期局面。
  const sfens: string[] = [startFen];
  const moves: GameMoveInfo[] = [];
  let result: string | undefined;

  while (record.goForward()) {
    const node = record.current;
    const move = node.move;

    // 特殊手（投了・千日手・持将棋・時間切れ 等）はメインラインの終端。
    // Move インスタンスでないものは全て特殊手として扱い、そこで打ち切る。
    // WHY instanceof で判定するか: isKnownSpecialMove は「既知の」特殊手しか弾かず、
    //   AnySpecialMove(未知の特殊手)を見逃す。Move かどうかで機械的に切る方が漏れがない。
    if (!(move instanceof Move)) {
      // 可能なら結果ラベル（"投了" 等）を拾っておく（UI 表示は任意）。
      try {
        result = formatSpecialMove(move);
      } catch {
        result = undefined;
      }
      break;
    }

    // 日本語表記(label)は「指す直前の局面」から作る必要がある。
    // 直前局面 = sfens の末尾。そこへ USI 手を当て直して formatMove する（スパイクと同一手法）。
    const posBefore = Position.newBySFEN(sfens[sfens.length - 1]);
    const rebuilt = posBefore ? posBefore.createMoveByUSI(move.usi) : null;
    const label =
      posBefore && rebuilt ? (safeFormatMove(posBefore, rebuilt) ?? move.usi) : move.usi;

    moves.push({ label, engineMove: move.usi });
    // 局面 SFEN は record.position（tsshogi の権威ある局面）から取る。
    sfens.push(record.position.sfen);
  }

  return {
    kind: 'shogi',
    startFen,
    moves,
    result,
    fenAt(index: number): string {
      if (index <= 0) return startFen;
      // sfens の範囲外は末尾（最終局面）に丸める。
      const clamped = Math.min(index, moves.length);
      return sfens[clamped];
    },
  };
}
