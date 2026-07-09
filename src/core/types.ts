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
   * ── 表示専用の手ラベル（クライアント描画のみ。LLM へは渡らない） ──
   * WHY ここに置くか / なぜ安全か（2026-07-09 バグ「解説に生 USI 7g7f が漏れる」対策）:
   *   将棋は engine が USI("7g7f")を返すが、ExplanationPanel（メインチャンク）はチェスの uciToSan で
   *   変換するため将棋 USI を変換できず生表記にフォールバックしていた。tsshogi(将棋一式)をメインチャンクに
   *   入れると 1 バイト不変条件違反になるので、日本語表記(☗７六歩)は将棋の解析経路（lazy = shogiNotation）で
   *   事前計算し、この表示専用フィールドに載せて panel へ運ぶ（panel は tsshogi に触れない）。
   *   **LLM へは渡らない**: これらは Edge Function の validate.ts が allowlist で drop する
   *   （validate.ts は fenOrSfen/movePlayed/bestMove/pv のみ再構築＝信頼境界は不変）。POST body に載っても
   *   サーバは無視するので、ユーザー由来でない engine 派生ラベルが LLM に混入することはない。
   *   チェスでは未設定（panel が従来どおり uciToSan で SAN 化する）。
   */
  /** 最善手の表示用ラベル（将棋=日本語 "☗７六歩"）。未設定なら panel が USI→SAN 変換にフォールバック。 */
  bestMoveLabel?: string;
  /** 読み筋(PV)の表示用ラベル列（将棋=日本語）。未設定なら panel が uciLineToSan にフォールバック。 */
  pvLabels?: string[];
}

/** ユーザーの専門用語理解プロファイル(半パーソナライズ用)。 */
export interface KnowledgeProfile {
  known: string[];
  unknown: string[];
  level?: 'beginner' | 'intermediate' | 'advanced';
}
