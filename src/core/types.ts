// アプリ共通のドメイン型。チェス先行だが将棋拡張も見据えた抽象。

export type GameKind = 'chess' | 'shogi';

/** エンジンの評価値。中心値(centipawn)か詰み手数(mate)のどちらか。常に手番側視点。 */
export type Score = { type: 'cp'; value: number } | { type: 'mate'; value: number };

/** 1つの読み筋(PV)候補。 */
export interface PvLine {
  multipv: number;
  score: Score;
  /** UCI形式の手の並び(例: ["e2e4", "e7e5"])。 */
  moves: string[];
}

/** ある局面に対するエンジン解析結果。 */
export interface AnalysisResult {
  fen: string;
  depth: number;
  lines: PvLine[];
  /** 最善手(UCI)。lines[0].moves[0] と一致。 */
  bestMove: string | null;
}

/** 手の質(lichess 方式に準拠)。 */
export type MoveQuality = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/** 棋譜の1手分のデータ。 */
export interface MoveRecord {
  /** 0始まりの手番インデックス。 */
  ply: number;
  /** SAN(例: "Nf3")。 */
  san: string;
  /** UCI(例: "g1f3")。 */
  uci: string;
  /** この手を指す直前の局面FEN。 */
  fenBefore: string;
  /** この手を指した直後の局面FEN。 */
  fenAfter: string;
  /** 手番。'w' | 'b'。 */
  color: 'w' | 'b';
}

/** LLM へ渡す構造化解説コンテキスト(エンジンの数値事実)。 */
export interface ExplanationContext {
  fenOrSfen: string;
  movePlayed?: string;
  /** 手番側視点の評価値(センチポーン)。 */
  evalBefore?: number;
  evalAfter?: number;
  bestMove?: string;
  pv?: string[];
  quality?: MoveQuality;
  /*
   * ── エンジン由来の正確な手ラベル（表示 + LLM の DATA 同梱の両方に使う） ──
   *
   * 旧仕様（〜2026-07-16）との違い（WHY 書き直したか / 未来の担当者が誤解しないように）:
   *   このコメントは元々「表示専用・LLM へは渡らない」と書いていたが、それは**もう正しくない**。
   *   本番 E2E（2026-07-08）で LLM が将棋の指し手を出発地基準で誤命名する実バグ
   *   （正: ▲２二角成 → 出力: ▲８八角成）が発覚し、根治として
   *   `docs/progress/explain-label-data-plan.md`（2026-07-16）でこの3フィールドを
   *   **検証付きで LLM の DATA にも同梱する**方針に変更した。
   *   座標(USI/UCI)から日本語表記/SANへの変換は「移動先座標+駒種+成/打の判別」という
   *   盤面理解を要する処理で LLM が誤りやすい。エンジン由来の正確なラベルをそのまま
   *   「引用」させることで、LLM に「変換」させない（変換ミスの発生源を丸ごと消す）。
   *
   * 新仕様の信頼境界（重要）:
   *   これらのフィールドはクライアント発の値（anon key で直叩き可能）なので、
   *   **`supabase/functions/_shared/validate.ts` が唯一の信頼境界**。同ファイルは
   *   型・長さ上限・制御文字除去を経て初めてこれらを受理し、`cacheKeyInput`/`normalizeContext`
   *   にも含める（含めないと「嘘ラベル付きリクエストで温めたキャッシュ」が他ユーザーに配られる
   *   キャッシュ汚染になる。validate.ts の該当コメント参照）。ここに書く値は「表示に使ってよい
   *   engine 派生ラベル」という前提は変わらないが、**サーバは無条件で信用してはいけない**。
   *
   * 生成元（クライアント側）:
   *   chess = `src/core/notation.ts` の `uciToSan`/`uciLineToSan`（同期・既にメインバンドル）。
   *   shogi = `src/core/shogiNotation.ts` の `usiToJapanese`/`usiLineToJapanese`
   *   （tsshogi 依存・1バイト不変条件により **動的 import 経由のみ**。`src/ui/moveLabels.ts` 参照）。
   *   付与元は `src/ui/moveLabels.ts` の `withMoveLabels`（旧 `withShogiMoveLabels` を chess/shogi
   *   対称に拡張・改名）。
   */
  /** 指した手の表示ラベル（将棋=日本語 "☗７六歩" / チェス=SAN "e4"）。解説の主語なので LLM 同梱の主役。 */
  movePlayedLabel?: string;
  /** 最善手の表示用ラベル（将棋=日本語 "☗７六歩" / チェス=SAN）。未設定なら panel が座標→表記変換にフォールバック。 */
  bestMoveLabel?: string;
  /** 読み筋(PV)の表示用ラベル列（将棋=日本語 / チェス=SAN）。未設定なら panel が uciLineToSan 等にフォールバック。 */
  pvLabels?: string[];
}

/** ユーザーの専門用語理解プロファイル(半パーソナライズ用)。 */
export interface KnowledgeProfile {
  known: string[];
  unknown: string[];
  level?: 'beginner' | 'intermediate' | 'advanced';
}
