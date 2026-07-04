/*
 * playGame.ts — 対局(AI戦/対人戦)用のステートフルなゲームコントローラ
 *
 * 位置づけ:
 *   ReviewView が使う `game.ts`(ChessGame) は「完成した PGN を読んで振り返る」= 不変・読み取り専用。
 *   こちらは「これから1手ずつ指していく」= 可変。役割が真逆なので別クラスに分ける。
 *   両者とも chess.js を土台にするが、混ぜると「読み取り専用のはずが変異する」事故を招くため
 *   意図的に分離している(将来の担当者へ: ReviewView に PlayGame を持ち込まないこと)。
 *
 * React との接続方針(重要):
 *   このクラスは可変オブジェクトなので useState では内部変異を検知できない。
 *   そこで「変異はメソッドで行い、描画に必要な読み取り値は snapshot() が返す不変オブジェクトに集約」する。
 *   呼び出し側(PlayView)は snapshot を state に持ち、各操作後に setSnapshot(game.snapshot()) で更新する。
 *   → 描画は常に state(不変) を読むso React の再描画契約を壊さない。
 *
 * 純粋性(テスト容易性):
 *   Date.now / Math.random / crypto はこのファイルで一切使わない。着手・勝敗判定は入力に対して決定的。
 *   ID 採番やタイムスタンプは呼び出し側(PlayView)の責務。これにより vitest で全分岐を安定に検証できる。
 */

import { Chess } from 'chess.js';

/** 盤上の色。chessground/UI は 'white'|'black'、chess.js 内部は 'w'|'b' を使うので境界で変換する。 */
export type PieceColor = 'white' | 'black';

/** 成り先の駒(クイーン/ルーク/ビショップ/ナイト)。chess.js の promotion 記法に一致。 */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

/**
 * 対局の結末。
 * over=false は続行中。over=true のとき winner=null は引き分け。
 * reason は UI のラベル分岐に使う(詰み/ステイルメイト/…/投了)。
 */
export type GameOutcome =
  | { over: false }
  | {
      over: true;
      reason:
        | 'checkmate' // 詰み
        | 'stalemate' // ステイルメイト(手番側に合法手なし・王手でない)
        | 'insufficient' // 駒不足で詰み不可能
        | 'threefold' // 同一局面3回
        | 'fiftyMove' // 50手ルール
        | 'draw' // その他の引き分け(保険)
        | 'resign'; // 投了
      /** 勝者。引き分けは null。 */
      winner: PieceColor | null;
    };

/** 対局中に指された1手分のデータ(履歴表示・振り返り用)。 */
export interface PlayMove {
  /** 0始まりの手番インデックス。 */
  ply: number;
  /** SAN(例: "Nf3")。 */
  san: string;
  /** UCI(例: "g1f3"、成りは "e7e8q")。chessground のハイライトにも使う。 */
  uci: string;
  /** 手番。'w' | 'b'。 */
  color: 'w' | 'b';
  /** この手を指した直後の局面 FEN。 */
  fenAfter: string;
}

/**
 * 描画に必要な読み取り専用スナップショット。
 * PlayView はこれを state に持ち、各操作後に差し替えることで React 再描画を駆動する。
 */
export interface PlaySnapshot {
  fen: string;
  /** 現在の手番。 */
  turn: PieceColor;
  /** 手番側が王手されているか(盤の王手ハイライト用)。 */
  inCheck: boolean;
  /**
   * chessground 用の合法手マップ: from(例 "e2") → 行ける to の配列。
   * 成りは同一 from→to が複数駒種で存在するため重複除去済み(行き先の集合として持つ)。
   */
  dests: Map<string, string[]>;
  /** ここまでの全手。 */
  history: PlayMove[];
  /** 直近手の UCI(なければ null)。盤のハイライト用。 */
  lastMoveUci: string | null;
  /** 結末(続行中/終局)。 */
  outcome: GameOutcome;
  /** 指した手数。 */
  moveCount: number;
}

/** chess.js の 'w'|'b' を UI の 'white'|'black' に変換。 */
function toColor(c: 'w' | 'b'): PieceColor {
  return c === 'w' ? 'white' : 'black';
}

/** 色を反転(勝者算出用)。 */
export function opposite(c: PieceColor): PieceColor {
  return c === 'white' ? 'black' : 'white';
}

/** 対局を1手ずつ進めるコントローラ。chess.js を土台にした可変ステート。 */
export class PlayGame {
  private chess: Chess;
  /** 投了した色(あれば)。chess.js は投了を表現しないので別フラグで持つ。 */
  private resignedBy: PieceColor | null = null;

  /** 開始局面(省略時は標準初期配置)。将来の「途中局面から対局」用に startFen を受ける。 */
  constructor(startFen?: string) {
    this.chess = startFen ? new Chess(startFen) : new Chess();
  }

  /** 現在の局面 FEN。 */
  get fen(): string {
    return this.chess.fen();
  }

  /** 現在の手番。 */
  get turn(): PieceColor {
    return toColor(this.chess.turn());
  }

  /**
   * chessground 用の合法手 dests。from → to[] のマップ。
   *
   * WHY 重複除去するか:
   *   chess.js の verbose moves は成り(1マスに q/r/b/n)を4手として返すため、同じ to が
   *   複数回現れる。chessground は集合として扱えれば十分なので Set で重複を潰す。
   */
  legalDests(): Map<string, string[]> {
    const dests = new Map<string, string[]>();
    for (const m of this.chess.moves({ verbose: true })) {
      const arr = dests.get(m.from) ?? [];
      if (!arr.includes(m.to)) arr.push(m.to);
      dests.set(m.from, arr);
    }
    return dests;
  }

  /**
   * from→to が成りを要する手か(=ポーンが最終段に到達)。
   * UI はこれを見て成り駒ピッカーを出すか判断する。合法な成り手が1つでもあれば true。
   */
  needsPromotion(from: string, to: string): boolean {
    return this.chess
      .moves({ verbose: true })
      .some((m) => m.from === from && m.to === to && Boolean(m.promotion));
  }

  /**
   * 着手する。成功したら PlayMove、非合法なら null(状態は不変のまま)。
   *
   * promotion 省略時は chess.js の既定でクイーン成りになるが、UI 側は needsPromotion で
   * 事前に成りを検出して明示指定する運用(意図しないクイーン強制を避ける)。
   *
   * WHY try/catch か: chess.js は版によって非合法手で例外を投げる/ null を返すのどちらもある。
   * どちらでも「状態を変えずに null」で統一し、呼び出し側の分岐を単純に保つ。
   */
  move(from: string, to: string, promotion?: PromotionPiece): PlayMove | null {
    // 終局後は着手を拒否する(自衛的不変条件)。
    // WHY core で守るか(Codex 指摘): UI は movableColor で盤をロックするが、UI バグや
    // 別経路(例: 成りピッカー表示中に投了→駒選択で確定)から終局後に move() が呼ばれ得る。
    // chess.js は「合法手なら終局後でも通す」ため、ここで止めないと終局後に棋譜が変異し、
    // 保存/振り返り用 PGN に終局後の手が混入する。undo()/待ったは move() を通らないので影響なし。
    if (this.outcome().over) return null;
    try {
      const mv = this.chess.move({ from, to, promotion });
      if (!mv) return null;
      return {
        ply: this.chess.history().length - 1,
        san: mv.san,
        uci: mv.lan,
        color: mv.color,
        fenAfter: this.chess.fen(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 直近1手を取り消す(「待った」の低レベル操作)。取り消せたら true。
   * 投了後でも棋譜の手は戻せるが、resign フラグは別途 clearResign() で戻す設計。
   */
  undo(): boolean {
    const undone = this.chess.undo();
    return undone !== null;
  }

  /** 投了。winner はその相手の色になる(outcome で算出)。 */
  resign(color: PieceColor): void {
    this.resignedBy = color;
  }

  /** 投了フラグを解除(待ったで終局を巻き戻すとき用)。 */
  clearResign(): void {
    this.resignedBy = null;
  }

  /** ここまでの全手(0始まり ply)。 */
  history(): PlayMove[] {
    return this.chess.history({ verbose: true }).map((m, i) => ({
      ply: i,
      san: m.san,
      uci: m.lan,
      color: m.color,
      fenAfter: m.after,
    }));
  }

  /** 直近手の UCI(ハイライト用)。手がなければ null。 */
  lastMoveUci(): string | null {
    const h = this.chess.history({ verbose: true });
    return h.length > 0 ? h[h.length - 1].lan : null;
  }

  /** 指した手数。 */
  get moveCount(): number {
    return this.chess.history().length;
  }

  /** 手番側が王手されているか。 */
  get inCheck(): boolean {
    return this.chess.inCheck();
  }

  /**
   * 現在の結末を判定する。
   *
   * 判定順序が重要(WHY):
   *   投了 → 詰み → ステイルメイト → 駒不足 → 3回同形 → 50手 → その他引分。
   *   chess.js の isDraw() は「駒不足 or 3回 or 50手」を包含するため、具体的な理由を先に
   *   個別判定し、最後に残った isDraw() を 50手ルール(fiftyMove)として扱う。順序を崩すと
   *   「詰みなのに引き分け」等の誤判定が起きるので、この順序は動かさないこと。
   */
  outcome(): GameOutcome {
    if (this.resignedBy) {
      return { over: true, reason: 'resign', winner: opposite(this.resignedBy) };
    }
    if (this.chess.isCheckmate()) {
      // 詰み: 手番側が「指せない=詰まされた」ので敗者。勝者はその相手。
      const loser = this.turn;
      return { over: true, reason: 'checkmate', winner: opposite(loser) };
    }
    if (this.chess.isStalemate()) {
      return { over: true, reason: 'stalemate', winner: null };
    }
    if (this.chess.isInsufficientMaterial()) {
      return { over: true, reason: 'insufficient', winner: null };
    }
    if (this.chess.isThreefoldRepetition()) {
      return { over: true, reason: 'threefold', winner: null };
    }
    if (this.chess.isDraw()) {
      // 上の個別引き分けを潰した後に残る isDraw() は 50手ルール由来とみなす。
      return { over: true, reason: 'fiftyMove', winner: null };
    }
    return { over: false };
  }

  /**
   * PGN の Result トークン('1-0'|'0-1'|'1/2-1/2'|'*')。
   * 続行中は '*'。ReviewView への受け渡し PGN の Result ヘッダに使う。
   */
  resultToken(): string {
    const o = this.outcome();
    if (!o.over) return '*';
    if (o.winner === 'white') return '1-0';
    if (o.winner === 'black') return '0-1';
    return '1/2-1/2';
  }

  /**
   * ヘッダ付き PGN を返す。振り返り(ReviewView)や履歴保存に使う。
   * Result ヘッダは resultToken() で上書きする(投了は chess.js が終局を知らないため必須)。
   */
  pgn(headers?: Record<string, string>): string {
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.chess.header(k, v);
    }
    this.chess.header('Result', this.resultToken());
    return this.chess.pgn();
  }

  /** 描画に必要な読み取り値を1つの不変オブジェクトに集約(React state 用)。 */
  snapshot(): PlaySnapshot {
    return {
      fen: this.fen,
      turn: this.turn,
      inCheck: this.inCheck,
      dests: this.legalDests(),
      history: this.history(),
      lastMoveUci: this.lastMoveUci(),
      outcome: this.outcome(),
      moveCount: this.moveCount,
    };
  }
}
