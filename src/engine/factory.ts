import type { ChessEngine } from './types';
import { StockfishEngine } from './stockfish';
import { MockEngine } from './mock';

export type EngineKind = 'stockfish' | 'mock';

/**
 * エンジンを生成して初期化する。
 * 既定は Stockfish(WASM)。ロードに失敗したら(エンジン未配置など)モックにフォールバック。
 * VITE_ENGINE=mock で明示的にモックを選べる。
 */
export async function createEngine(
  preferred?: EngineKind,
): Promise<{ engine: ChessEngine; kind: EngineKind }> {
  const want = preferred ?? (import.meta.env.VITE_ENGINE as EngineKind | undefined) ?? 'stockfish';

  if (want === 'mock') {
    const engine = new MockEngine();
    await engine.init();
    return { engine, kind: 'mock' };
  }

  try {
    const engine = new StockfishEngine();
    await engine.init();
    return { engine, kind: 'stockfish' };
  } catch {
    const engine = new MockEngine();
    await engine.init();
    return { engine, kind: 'mock' };
  }
}
