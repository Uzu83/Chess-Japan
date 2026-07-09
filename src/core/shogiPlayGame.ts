/*
 * shogiPlayGame.ts — 将棋の対局(AI戦)用ステートフルなゲームコントローラ（tsshogi ベース）
 *
 * 位置づけ（playGame.ts の将棋版・写像）:
 *   ReviewView が使う shogiGame.ts(shogiGameModel) は「完成した棋譜を読んで振り返る」= 不変・読み取り専用。
 *   こちらは「これから1手ずつ指していく」= 可変。役割が真逆なので別モジュールに分ける
 *   （将来の担当者へ: 振り返り側に ShogiPlayGame を持ち込まないこと。逆も同様）。
 *
 * WHY 動的 import 到達専用か（1バイト不変条件）:
 *   このファイルは tsshogi に静的依存する。チェス利用者に将棋一式を 1 バイトも払わせないため、
 *   到達は必ず動的 import（ShogiPlaySession → `await import('../core/shogiPlayGame')` 相当）に限定する。
 *   メインチャンク（チェス経路）から静的に import してはならない。
 *
 * WHY tsshogi の Record を可変ストアに使うか（自前で局面列を持たない理由）:
 *   千日手（同一局面4回）と連続王手の千日手は「手順の履歴」に依存する終局判定で、自前実装すると
 *   バグの温床になる。tsshogi の Record は append で手を進めるたびに repetition カウントを内部で維持し、
 *   `record.repetition` / `record.perpetualCheck` を提供する（Phase 4-0 スパイクで実測 PASS）。
 *   よって「手を積む器」として Record を使い、終局判定はライブラリの権威ある実装に委ねる。
 *
 * React との接続方針（playGame.ts と一致）:
 *   可変オブジェクトなので useState では内部変異を検知できない。変異はメソッドで行い、描画に必要な
 *   読み取り値は snapshot() が返す不変オブジェクトへ集約する。純粋性のため Date/Math.random/crypto は
 *   使わない（ID・時刻は UI 側の責務）。着手・勝敗判定は入力に対して決定的。
 */

import {
  // tsshogi の Record クラスは TypeScript 組み込みの Record<K,V> ユーティリティ型と名前が衝突するため
  // ShogiRecord に別名化する（このファイル内で Record<string, number> を使いたいので必須）。
  Record as ShogiRecord,
  Position,
  Move,
  Square,
  Color,
  PieceType,
  RecordMetadataKey,
  exportKIF,
  InitialPositionSFEN,
} from 'tsshogi';
import type { Color as TsColor, ImmutablePosition } from 'tsshogi';
import type { PlayController, PlayOutcome as GenericPlayOutcome } from './playController';

/** 将棋の手番色。tsshogi の Color(BLACK=先手/WHITE=後手) を UI に馴染む語彙へ写す。 */
export type ShogiColor = 'sente' | 'gote';

/** 将棋の終局理由。 */
export type ShogiPlayReason =
  | 'checkmate' // 詰み（手番側に合法手が1つも無い＝総手詰み含む）
  | 'repetition' // 千日手（同一局面4回・引き分け）
  | 'perpetualCheck' // 連続王手の千日手（王手をかけ続けた側の負け）
  | 'resign'; // 投了

/** 将棋対局の結末（続行中 or 終局）。 */
export type ShogiPlayOutcome = GenericPlayOutcome<ShogiColor, ShogiPlayReason>;

/** 対局中の 1 手分（履歴表示・棋譜用）。 */
export interface ShogiPlayMove {
  /** 1 始まりの手数（tsshogi の Node.ply に一致）。 */
  ply: number;
  /** USI（例 "7g7f" / 打ち "P*5e" / 成り "7g7f+"）。盤ハイライトにも使う。 */
  usi: string;
  /** 日本語表記（例 "☗７六歩"）。tsshogi の displayText。 */
  label: string;
  /** この手を指した側。 */
  color: ShogiColor;
}

/**
 * 描画に必要な読み取り専用スナップショット。
 * ShogiPlaySession はこれを state に持ち、各操作後に差し替えて React 再描画を駆動する。
 */
export interface ShogiPlaySnapshot {
  /** 現在局面（SFEN）。 */
  sfen: string;
  /** 現在の手番。 */
  turn: ShogiColor;
  /** 手番側が王手されているか（盤の王手ハイライト用）。 */
  inCheck: boolean;
  /** 指した手数。 */
  moveCount: number;
  /** 直近手の USI（なければ null）。盤ハイライト用。 */
  lastMoveUsi: string | null;
  /**
   * 盤上の合法手 dests: from(USI マス, 例 "7g") → 行ける to[]。
   * 成り強制の駒（例: 歩が最終段へ）も「行ける」ので to に含める（成り不成の分岐は move 側）。
   */
  legalDests: Map<string, string[]>;
  /**
   * 持ち駒打ちの dests: 駒種ロール("pawn" 等) → 打てる to[]。
   * ロール名は shogiground の役名（未成駒は tsshogi PieceType の値と同一文字列）。
   */
  dropDests: Map<string, string[]>;
  /** 両者の持ち駒サマリ（ロール→枚数）。プレイヤープレート等の表示用。 */
  hands: { sente: Record<string, number>; gote: Record<string, number> };
  /** ここまでの全手。 */
  history: ShogiPlayMove[];
  /** 結末（続行中/終局）。 */
  outcome: ShogiPlayOutcome;
}

/** exportKif に渡せるヘッダ（対局者名・表題）。振り返り接続では省略可。 */
export interface ShogiKifHeaders {
  black?: string;
  white?: string;
  title?: string;
}

/** 標準初期局面の SFEN（平手）。constructor 省略時の既定。Phase 4-3 でカスタム開始 SFEN も受ける
 *  （UI は validateStartSfen で事前検証してから渡す）。 */
const STANDARD_SFEN = InitialPositionSFEN.STANDARD;

/**
 * 持ち駒として打てる駒のロール → USI 打ち駒文字（大文字）。
 * USI の打ちは色に依らず大文字1文字（例 "P*5e"）。色は局面の手番から決まる。
 * ここに載る 7 種だけが持ち駒になり得る（玉・成駒は持ち駒にならない）。
 */
const HAND_ROLE_TO_USI: Record<string, string> = {
  pawn: 'P',
  lance: 'L',
  knight: 'N',
  silver: 'S',
  gold: 'G',
  bishop: 'B',
  rook: 'R',
};

/** tsshogi Color → UI 手番色。BLACK=先手=sente / WHITE=後手=gote。 */
function fromTsColor(c: TsColor): ShogiColor {
  return c === Color.BLACK ? 'sente' : 'gote';
}

/** 手番色を反転（勝者算出用）。 */
export function oppositeShogiColor(c: ShogiColor): ShogiColor {
  return c === 'sente' ? 'gote' : 'sente';
}

/** validateStartSfen の結果（OK なら手番色つき）。 */
export type StartSfenValidation = { ok: true; turn: ShogiColor } | { ok: false; reason: string };

/**
 * 「局面(SFEN)から対局」（Phase 4-3）の開始 SFEN を検証する pure 関数。
 *
 * WHY UI の手前に純粋関数の検証を挟むか（validate.ts と同じ信頼境界思想）:
 *   ShogiPlayGame の constructor は不正 SFEN を平手へ自衛フォールバックする（:171-175）が、それは
 *   「黙って別局面で始まる」= ユーザーが貼った局面と違う盤で対局が始まる悪い UX になる。UI は開始前に
 *   この関数で弾き、理由を提示して設定画面に留める（チェスが chess.js の throw を catch して留まるのと対称）。
 *   tsshogi 依存をこのファイル（=lazy チャンク）に閉じることで、PlayView（メインチャンク）へ tsshogi を
 *   漏らさない（1 バイト不変条件）。
 *
 * 検証段:
 *   (1) Position.newBySFEN が null → 構文不正（段数不足・不正手番文字・空 等。node 実測で null 確認済み）。
 *   (2) 盤面トークンの玉が「先手玉 K・後手玉 k がそれぞれちょうど 1 枚」でない → 非合法。
 *       WHY 存在ではなく個数か（Codex ゲート① F002・実測）: Position.newBySFEN は玉なし局面も
 *       重複玉局面（K が 2 枚 等）も null にせず通す。玉なし/重複玉のままやねうら王へ渡すと非合法局面で
 *       bestmove 異常・無応答・終局判定破綻が起きうる。攻方玉を省く純詰将棋は本 MVP では非対応
 *       （チェス側 chess.js も両玉必須なのと対称）。王は成れないので盤トークンの K/k は玉のみ＝誤検出なし。
 *       持ち駒に玉は入らないので、盤面トークン（split の [0]）だけを見れば持ち駒トークンを巻き込まない。
 *
 * 深い合法性（隣接玉・手番側が相手玉を取れる等）は検証しない（意図的スコープ限定・Codex ゲート① 合意）:
 *   主入口（レビューからの「この局面から対局」）は常に合法局面を渡す。手貼りの subtly-illegal は
 *   既存の graceful エラー処理（AI 応答失敗フラグ・null bestmove→AI 投了）が backstop になる。
 *   完全合法性検証はエンジンロジックの重複で、合法エッジ局面を誤って弾くリスクがある。
 */
export function validateStartSfen(sfen: string): StartSfenValidation {
  const trimmed = sfen.trim();
  const pos = Position.newBySFEN(trimmed);
  if (!pos) return { ok: false, reason: 'SFEN を解釈できませんでした' };
  // 盤面トークン（最初の空白まで）の玉個数を数える。持ち駒・手番・手数トークンは巻き込まない。
  const board = trimmed.split(/\s+/)[0] ?? '';
  const senteKings = (board.match(/K/g) ?? []).length;
  const goteKings = (board.match(/k/g) ?? []).length;
  if (senteKings !== 1 || goteKings !== 1) {
    return { ok: false, reason: '先手玉・後手玉がそれぞれ 1 枚ずつ必要です' };
  }
  return { ok: true, turn: fromTsColor(pos.color) };
}

/**
 * 指定色の駒があるマスの一覧を返す。
 * WHY listSquaresByColor を使わないか: record.position は ImmutablePosition で、その board は
 * ImmutableBoard（listSquaresByColor は可変 Board クラス限定）。ImmutableBoard で使える
 * listNonEmptySquares + at で色フィルタする（読み取りだけなので不変面で十分）。
 */
function squaresOfColor(pos: ImmutablePosition, color: TsColor): Square[] {
  return pos.board.listNonEmptySquares().filter((sq) => pos.board.at(sq)?.color === color);
}

/** 持ち駒(Hand)を「ロール名→枚数」の素なオブジェクトへ写す（snapshot 用の不変化）。 */
function handToSummary(hand: {
  counts: { type: PieceType; count: number }[];
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { type, count } of hand.counts) {
    if (count > 0) out[type] = count;
  }
  return out;
}

/**
 * 将棋対局を 1 手ずつ進めるコントローラ。tsshogi の Record/Position を土台にした可変ステート。
 * PlayController の面（chess の PlayGame と対になる契約）を満たす。
 */
export class ShogiPlayGame implements PlayController<
  ShogiColor,
  string,
  ShogiPlayReason,
  ShogiPlaySnapshot
> {
  private record: ShogiRecord;
  /** 投了した色（あれば）。tsshogi は「対局としての投了」を局面に持たないので別フラグで持つ。 */
  private resignedBy: ShogiColor | null = null;

  /** 開始局面（省略時は平手初期局面）。 */
  constructor(startSfen: string = STANDARD_SFEN) {
    const pos = Position.newBySFEN(startSfen);
    // 不正 SFEN は平手初期局面へフォールバック（呼び出し側でのバリデーション前提だが自衛）。
    this.record = new ShogiRecord(pos ?? Position.newBySFEN(STANDARD_SFEN)!);
  }

  /** 現在局面（SFEN）。 */
  get sfen(): string {
    return this.record.position.sfen;
  }

  /** 現在の手番。 */
  get turn(): ShogiColor {
    return fromTsColor(this.record.position.color);
  }

  /** 手番側が王手されているか。 */
  get inCheck(): boolean {
    return this.record.position.checked;
  }

  /** 指した手数。 */
  get moveCount(): number {
    return this.history().length;
  }

  /** 直近手の USI（無ければ null）。 */
  lastMoveUsi(): string | null {
    const cur = this.record.current.move;
    return cur instanceof Move ? cur.usi : null;
  }

  /**
   * 盤上の合法手 dests（from USI → to[] USI）。
   *
   * WHY 成り強制の to も含めるか（重要）:
   *   歩が最終段へ進む手は「不成」が非合法で「成り」だけが合法。plain(不成) の isValidMove だけを
   *   見ると、この to を dests から取りこぼして盤に着手できなくなる。よって plain が非合法なら
   *   成り版(withPromote)も試し、どちらかが合法なら to を採用する。成り不成の選択は move 側で行う。
   */
  legalDests(): Map<string, string[]> {
    const pos = this.record.position;
    const dests = new Map<string, string[]>();
    // 手番側の駒があるマスだけを from 候補にする（全 81 マス総当りより軽い）。
    for (const from of squaresOfColor(pos, pos.color)) {
      const tos: string[] = [];
      for (const to of Square.all) {
        const plain = pos.createMove(from, to);
        if (!plain) continue;
        let ok = pos.isValidMove(plain);
        if (!ok) ok = pos.isValidMove(plain.withPromote()); // 強制成りの救済
        if (ok) tos.push(to.usi);
      }
      if (tos.length > 0) dests.set(from.usi, tos);
    }
    return dests;
  }

  /**
   * 持ち駒打ちの合法 dests（ロール名 → 打てる to[] USI）。
   * 打ち歩詰め・二歩・行き所のない駒打ちは tsshogi の isValidMove が弾く（Phase 4-0 実測 PASS）。
   */
  dropDests(): Map<string, string[]> {
    const pos = this.record.position;
    const dests = new Map<string, string[]>();
    for (const { type, count } of pos.hand(pos.color).counts) {
      if (count <= 0) continue;
      const role = type as string;
      if (!(role in HAND_ROLE_TO_USI)) continue; // 念のため（玉/成駒は持ち駒にならない）
      const tos: string[] = [];
      for (const to of Square.all) {
        if (pos.board.at(to)) continue; // 空きマスにしか打てない
        const m = pos.createMove(type, to);
        if (m && pos.isValidMove(m)) tos.push(to.usi);
      }
      if (tos.length > 0) dests.set(role, tos);
    }
    return dests;
  }

  /**
   * from→to が「成る/不成の選択」を要する手か。
   * 成れる駒で、かつ不成・成りの両方が合法なときだけ true（UI がピッカーを出す）。
   * 強制成り（不成が非合法）は false を返し、move 側で自動成りにする。
   */
  needsPromotionChoice(from: string, to: string): boolean {
    const pos = this.record.position;
    const plain = pos.createMoveByUSI(`${from}${to}`);
    const prom = pos.createMoveByUSI(`${from}${to}+`);
    return Boolean(plain && prom && pos.isValidMove(plain) && pos.isValidMove(prom));
  }

  /**
   * 盤上の着手。成功=true / 終局後・非合法=false（状態は不変のまま）。
   *
   * promote:
   *   - true/false … その通りに指す（false で強制成りが必要な手は非合法なので false 返し）。
   *   - undefined  … 自動判定。不成が合法ならそれ、非合法なら成り（＝行き所のない駒の強制成り）。
   */
  move(from: string, to: string, promote?: boolean): boolean {
    // 終局後は着手を拒否する（playGame.ts の不変条件を踏襲）。
    // WHY core で守るか: UI は盤をロックするが、UI バグや別経路（成りピッカー表示中に投了→駒選択）
    // から終局後に move() が呼ばれ得る。ここで止めないと終局後に棋譜が変異し、保存/振り返り用の
    // KIF に終局後の手が混入する。undo()/待ったは move() を通らないので影響なし。
    if (this.outcome().over) return false;

    const base = `${from}${to}`;
    let usi: string;
    if (promote === true) usi = `${base}+`;
    else if (promote === false) usi = base;
    else {
      // 自動: 不成が合法ならそれを採用、非合法なら成り（強制成り）に倒す。
      const pos = this.record.position;
      const plain = pos.createMoveByUSI(base);
      usi = plain && pos.isValidMove(plain) ? base : `${base}+`;
    }
    return this.applyUsi(usi);
  }

  /**
   * 持ち駒打ち。成功=true。禁じ手（打ち歩詰め・二歩・行き所なし）・終局後は false。
   * @param piece 打つ駒のロール名（"pawn" 等。shogiground の役名 = tsshogi PieceType 値）。
   */
  drop(piece: string, to: string): boolean {
    if (this.outcome().over) return false;
    const letter = HAND_ROLE_TO_USI[piece];
    if (!letter) return false;
    return this.applyUsi(`${letter}*${to}`);
  }

  /**
   * USI 手（エンジン応手・打ち・成り含む）を適用する。合法なら Record に積んで true。
   * エンジン応手（7g7f / P*5e / 7g7f+）の適用にも使う共通経路。
   */
  applyUsi(usi: string): boolean {
    if (this.outcome().over) return false;
    const move = this.record.position.createMoveByUSI(usi);
    if (!move) return false;
    // isValidMove で先に弾く（append 内の doMove も検証するが、意図を明示し二重に守る）。
    if (!this.record.position.isValidMove(move)) return false;
    return this.record.append(move);
  }

  /**
   * 直近1手を取り消す（「待った」の低レベル操作）。取り消せたら true。
   * removeCurrentMove は手を履歴から実際に削除し、内部の千日手カウントも goBack で戻る
   * （棋譜に「戻した手」が残らないので exportKif に現れない）。投了フラグは clearResign で別途戻す。
   */
  undo(): boolean {
    // START ノードしか無い（0手）なら戻せない。
    if (!(this.record.current.move instanceof Move)) return false;
    return this.record.removeCurrentMove();
  }

  /** 投了。winner はその相手の色になる（outcome で算出）。 */
  resign(color: ShogiColor): void {
    this.resignedBy = color;
  }

  /** 投了フラグを解除（待ったで終局を巻き戻すとき用）。 */
  clearResign(): void {
    this.resignedBy = null;
  }

  /** ここまでの全手（1 始まり ply・日本語表記つき）。 */
  history(): ShogiPlayMove[] {
    const out: ShogiPlayMove[] = [];
    for (const node of this.record.moves) {
      const mv = node.move;
      if (!(mv instanceof Move)) continue; // 先頭の START ノード等は除外
      out.push({
        ply: node.ply,
        usi: mv.usi,
        label: node.displayText, // tsshogi が生成する "☗７六歩" 等
        color: fromTsColor(mv.color),
      });
    }
    return out;
  }

  /**
   * 現在の結末を判定する。
   *
   * 判定順序（WHY）:
   *   投了 → 詰み（合法手ゼロ）→ 千日手/連続王手。
   *   ・詰み: 手番側に合法手（盤・打ち）が 1 つも無ければ負け。将棋には引き分けのステイルメイトが
   *     無く「動けない＝負け」なので、王手の有無に依らず手番側の負けとして扱う。
   *   ・千日手: 同一局面4回。連続王手の千日手なら「王手をかけ続けた側の負け」。tsshogi の
   *     perpetualCheck は "王手を継続していた色" を返す（= その色が負け）ので winner はその反対。
   *     連続王手でなければ引き分け（winner=null）。
   *   （持将棋宣言は 4-2 では実装しない＝合意済み。入玉膠着は投了/待ったで離脱可能。）
   */
  outcome(): ShogiPlayOutcome {
    if (this.resignedBy) {
      return { over: true, reason: 'resign', winner: oppositeShogiColor(this.resignedBy) };
    }
    // 詰み: 手番側に合法手が無い。
    if (!this.hasAnyLegalMove()) {
      const loser = this.turn;
      return { over: true, reason: 'checkmate', winner: oppositeShogiColor(loser) };
    }
    // 千日手（同一局面4回）。
    if (this.record.repetition) {
      const pc = this.record.perpetualCheck; // Color | null（王手継続側＝負け）
      if (pc) {
        const loser = fromTsColor(pc);
        return { over: true, reason: 'perpetualCheck', winner: oppositeShogiColor(loser) };
      }
      return { over: true, reason: 'repetition', winner: null };
    }
    return { over: false };
  }

  /**
   * 手番側に合法手（盤上の着手 or 持ち駒打ち）が 1 つでもあるか。詰み判定の心臓。
   * legalDests/dropDests を作り切らず、最初の 1 手が見つかった時点で打ち切る（詰み判定の高速化）。
   */
  private hasAnyLegalMove(): boolean {
    const pos = this.record.position;
    for (const from of squaresOfColor(pos, pos.color)) {
      for (const to of Square.all) {
        const plain = pos.createMove(from, to);
        if (!plain) continue;
        if (pos.isValidMove(plain)) return true;
        if (pos.isValidMove(plain.withPromote())) return true;
      }
    }
    for (const { type, count } of pos.hand(pos.color).counts) {
      if (count <= 0) continue;
      if (!((type as string) in HAND_ROLE_TO_USI)) continue;
      for (const to of Square.all) {
        if (pos.board.at(to)) continue;
        const m = pos.createMove(type, to);
        if (m && pos.isValidMove(m)) return true;
      }
    }
    return false;
  }

  /**
   * 振り返り接続用の KIF を返す。shogiGame.ts(shogiGameModel) がそのまま再読込できる
   * （テストで KIF 往復＝ move 列が保存されることを保証している）。
   */
  exportKif(headers?: ShogiKifHeaders): string {
    if (headers?.black)
      this.record.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, headers.black);
    if (headers?.white)
      this.record.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, headers.white);
    if (headers?.title)
      this.record.metadata.setStandardMetadata(RecordMetadataKey.TITLE, headers.title);
    return exportKIF(this.record);
  }

  /** PlayController 契約の別名（chess の pgn() に対応する棋譜文字列アクセサ）。 */
  exportRecord(): string {
    return this.exportKif();
  }

  /** 描画に必要な読み取り値を1つの不変オブジェクトへ集約（React state 用）。 */
  snapshot(): ShogiPlaySnapshot {
    const pos = this.record.position;
    return {
      sfen: this.sfen,
      turn: this.turn,
      inCheck: this.inCheck,
      moveCount: this.moveCount,
      lastMoveUsi: this.lastMoveUsi(),
      legalDests: this.legalDests(),
      dropDests: this.dropDests(),
      hands: {
        sente: handToSummary(pos.hand(Color.BLACK)),
        gote: handToSummary(pos.hand(Color.WHITE)),
      },
      history: this.history(),
      outcome: this.outcome(),
    };
  }
}
