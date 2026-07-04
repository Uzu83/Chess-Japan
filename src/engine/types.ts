import type { AnalysisResult } from '../core/types';

/** 解析オプション。 */
export interface AnalyzeOptions {
  /** 探索深さ。 */
  depth?: number;
  /** 上位何手まで読み筋を返すか(MultiPV)。 */
  multipv?: number;
}

/**
 * 対局(AI戦)時の着手生成オプション。
 *
 * WHY analyze() と分けるか:
 *   analyze() は「振り返り用の客観評価」で常に最善を尽くさせる(MultiPV・深さ固定)。
 *   対局では逆に「わざと弱く指させる」ことが UX の核心(初心者が勝てる相手が要る)。
 *   同じ go コマンドでも目的が真逆なので、専用メソッドに分離して意図を明示する。
 */
export interface PlayOptions {
  /**
   * Stockfish の Skill Level(0〜20)。弱い AI を作るための主レバー。
   * 0〜3 で人間の初心者〜中級、20 で全力。depth を絞るより自然に弱くなる
   * (低 Skill は候補手にノイズを入れるため、浅い探索の"機械的な弱さ"と違い人間らしい)。
   * MockEngine では無視される(常に駒得ベストを返す)。
   */
  skill?: number;
  /**
   * 1手あたりの思考時間(ms)。movetime 指定は端末性能に依らず体感速度を一定に保てる。
   * WHY depth でなく movetime を主にするか: lite-single(単スレッド)は端末差が大きく、
   * depth 固定だと速い端末では一瞬・遅い端末では待たされる。時間指定なら体感が揃う。
   */
  movetimeMs?: number;
  /** movetimeMs 未指定時のフォールバック探索深さ。 */
  depth?: number;
}

/** チェスエンジンの抽象。Stockfish(WASM) と モック が実装する。 */
export interface ChessEngine {
  /** エンジンを初期化(WASM ロード等)。 */
  init(): Promise<void>;
  /** 局面(FEN)を解析する。 */
  analyze(fen: string, opts?: AnalyzeOptions): Promise<AnalysisResult>;
  /**
   * 対局用に1手を選ばせる(UCI 文字列、合法手が無ければ null)。
   * analyze() と違い MultiPV=1・Skill Level 制御で「対局相手」として指す。
   */
  chooseMove(fen: string, opts?: PlayOptions): Promise<string | null>;
  /** 解放。 */
  dispose(): void;
}
