import type { ChessEngine } from './types';
import { StockfishEngine } from './stockfish';
import { MockEngine, MockShogiEngine } from './mock';

export type EngineKind = 'stockfish' | 'mock';
/** 将棋エンジンの実装種別（本物=やねうら王 / フォールバック=モック）。 */
export type ShogiEngineKind = 'yaneuraou' | 'mock';

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

/**
 * 将棋エンジンを生成して初期化する。既定はやねうら王(WASM)。
 *
 * WHY やねうら王を動的 import するか（1バイト不変条件）:
 *   yaneuraou.ts は将棋エンジン一式に繋がる重量モジュール。ここで `await import('./yaneuraou')` と
 *   することで、チェス利用者が読むメインチャンクから切り離し、将棋タブを開いたときだけ読み込ませる。
 *   静的 import にすると将棋コードがメインバンドルへ漏れる（＝1バイト不変条件違反）ので厳禁。
 *
 * フォールバック: init 失敗（crossOriginIsolated=false の Safari 等、またはグルー読込失敗）は
 *   MockShogiEngine に落とす。MockShogiEngine は mock.ts（静的・tsshogi 非依存）にあるので
 *   ここで動的 import 不要。VITE_ENGINE=mock でも明示的にモックを選べる。
 */
export async function createShogiEngine(
  preferred?: ShogiEngineKind,
): Promise<{ engine: ChessEngine; kind: ShogiEngineKind }> {
  const want =
    preferred ??
    ((import.meta.env.VITE_ENGINE as string | undefined) === 'mock' ? 'mock' : 'yaneuraou');

  if (want === 'mock') {
    const engine = new MockShogiEngine();
    await engine.init();
    return { engine, kind: 'mock' };
  }

  try {
    const { YaneuraOuEngine } = await import('./yaneuraou');
    const engine = new YaneuraOuEngine();
    await engine.init();
    return { engine, kind: 'yaneuraou' };
  } catch {
    const engine = new MockShogiEngine();
    await engine.init();
    return { engine, kind: 'mock' };
  }
}
