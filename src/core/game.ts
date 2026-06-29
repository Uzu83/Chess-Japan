import { Chess } from 'chess.js';
import type { MoveRecord } from './types';

/** チェスの棋譜モデル。PGN を読み込み、各手の前後FEN・SAN・UCI を提供する。 */
export class ChessGame {
  readonly startFen: string;
  readonly moves: MoveRecord[];

  private constructor(startFen: string, moves: MoveRecord[]) {
    this.startFen = startFen;
    this.moves = moves;
  }

  /** PGN 文字列から棋譜モデルを構築する。不正な PGN は例外を投げる。 */
  static fromPgn(pgn: string): ChessGame {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const verbose = chess.history({ verbose: true });

    const moves: MoveRecord[] = verbose.map((m, i) => ({
      ply: i,
      san: m.san,
      uci: m.lan, // chess.js の lan は from+to(+promotion) = UCI 表現
      fenBefore: m.before,
      fenAfter: m.after,
      color: m.color,
    }));

    const startFen = moves.length > 0 ? moves[0].fenBefore : new Chess().fen();
    return new ChessGame(startFen, moves);
  }

  /** 手数(指し手の総数)。 */
  get length(): number {
    return this.moves.length;
  }

  /**
   * 指定インデックスの局面FENを返す。
   * index=0 は開始局面、index=k は k手目を指した直後の局面。
   */
  fenAt(index: number): string {
    if (index <= 0) return this.startFen;
    const clamped = Math.min(index, this.moves.length);
    return this.moves[clamped - 1].fenAfter;
  }
}
