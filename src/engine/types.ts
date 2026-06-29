import type { AnalysisResult } from '../core/types';

/** 解析オプション。 */
export interface AnalyzeOptions {
  /** 探索深さ。 */
  depth?: number;
  /** 上位何手まで読み筋を返すか(MultiPV)。 */
  multipv?: number;
}

/** チェスエンジンの抽象。Stockfish(WASM) と モック が実装する。 */
export interface ChessEngine {
  /** エンジンを初期化(WASM ロード等)。 */
  init(): Promise<void>;
  /** 局面(FEN)を解析する。 */
  analyze(fen: string, opts?: AnalyzeOptions): Promise<AnalysisResult>;
  /** 解放。 */
  dispose(): void;
}
