/*
 * playController.ts — 対局(可変ゲーム)コントローラの「共通の面」= 型定義だけの層
 *
 * WHY このファイルは型定義のみで実装コードを持たないか（Codex ゲート① 修正 #4）:
 *   Phase 4-2 では chess(playGame.ts) と shogi(shogiPlayGame.ts) の 2 つの可変コントローラが並ぶ。
 *   両者を今すぐ 1 つの実装へ寄せる（共通基底クラス化する）と、密結合な状態機械を無理に一般化して
 *   かえって回帰リスクが上がる（playGame.ts は本番稼働中・チェス経路は 1 挙動も変えない不変条件）。
 *   そこで「実装は寄せず、満たすべき面（interface）だけを先に言語化」しておく。これは
 *     ①後任者が chess/shogi コントローラの対応関係を一目で掴める設計ドキュメント
 *     ②ShogiPlayGame が structural に満たすべき契約のコンパイル時チェック
 *   の二役を果たす。将来 chess を寄せたくなったら PlayGame にアダプタを被せてこの面を実装すればよい。
 *   （＝「今は寄せない、でも寄せる余地は型で残す」。Codex とはこの割り切りで合意済み。）
 *
 * バンドル注意（1バイト不変条件）:
 *   このファイルは型しか持たない（emit 0 バイト）ので、shogi 側から import してもチェスの
 *   メインチャンクに実コードは 1 バイトも増えない。ここに tsshogi / shogiground を絶対 import しない
 *   （型であっても実装モジュールへの参照はバンドラの解析対象になり得るため、依存は文字列型で表す）。
 */

/**
 * 終局の結末（続行中 or 終局）。`Color` はゲーム別の手番色型（chess='white'|'black' /
 * shogi='sente'|'gote'）を後から当てる。over=true・winner=null は引き分け。
 */
export type PlayOutcome<Color extends string, Reason extends string> =
  | { over: false }
  | {
      over: true;
      /** 終局理由。UI のラベル分岐に使う（詰み/千日手/連続王手/投了 など）。 */
      reason: Reason;
      /** 勝者。引き分けは null。 */
      winner: Color | null;
    };

/**
 * chess/shogi の可変コントローラが共通で満たす「対局の面」。
 *
 * 型パラメータ:
 *   - `Color`    手番色（'white'|'black' or 'sente'|'gote'）
 *   - `DropKey`  持ち駒打ちのキー（chess には打ちが無いので never を当てられる）
 *   - `Reason`   終局理由の文字列 union
 *   - `Snapshot` 描画用の不変スナップショット型（ゲーム別に具体化）
 *
 * 設計方針（playGame.ts と一致）:
 *   可変オブジェクトなので React の useState では内部変異を検知できない。変異はメソッドで行い、
 *   描画に必要な読み取り値は `snapshot()` が返す不変オブジェクトへ集約する（呼び出し側はそれを
 *   state に持ち、各操作後に差し替えて再描画を駆動する）。純粋性のため Date/Math.random/crypto は
 *   コントローラ内で使わない（ID・時刻採番は UI の責務）。
 */
export interface PlayController<
  Color extends string,
  DropKey extends string,
  Reason extends string,
  Snapshot,
> {
  /** 現在の手番。 */
  readonly turn: Color;
  /** 指した手数。 */
  readonly moveCount: number;
  /** 現在局面（chess=FEN / shogi=SFEN）。 */
  readonly sfen: string;

  /**
   * 盤操作の合法手 dests。from(座標文字列) → 行ける to[] のマップ。
   * shogiground / chessground の dests へそのまま渡せる形。
   */
  legalDests(): Map<string, string[]>;
  /**
   * 持ち駒打ちの合法 dests。駒種キー → 打てる to[]。
   * chess は打ちが無いので空マップ（DropKey=never）。
   */
  dropDests(): Map<DropKey, string[]>;

  /**
   * from→to が「成るか不成かの選択を要する」手か（成れるが強制でない）。
   * true のとき UI はピッカーを出す。強制成り（行き所のない駒）は move 側で自動成りにするため false。
   */
  needsPromotionChoice(from: string, to: string): boolean;

  /** 着手（成功=true）。終局後・非合法は false（状態は不変のまま）。 */
  move(from: string, to: string, promote?: boolean): boolean;
  /** 持ち駒打ち（成功=true）。禁じ手（打ち歩詰め等）・終局後は false。 */
  drop(piece: DropKey, to: string): boolean;

  /** 直近手を取り消す（「待った」の低レベル操作）。取り消せたら true。 */
  undo(): boolean;
  /** 投了（winner は相手側になる）。 */
  resign(color: Color): void;
  /** 投了フラグを解除（待ったで終局を巻き戻すとき用）。 */
  clearResign(): void;

  /** 現在の結末。 */
  outcome(): PlayOutcome<Color, Reason>;

  /** 振り返り接続用の棋譜文字列（chess=PGN / shogi=KIF）。 */
  exportRecord(): string;

  /** 描画用の不変スナップショット。 */
  snapshot(): Snapshot;
}
