import type { AnalysisResult, PvLine } from '../core/types';
import type { AnalyzeOptions, ChessEngine } from './types';
import { parseBestMove, parseInfoLine } from './uci';

const DEFAULT_ENGINE_URL =
  (import.meta.env.VITE_ENGINE_URL as string | undefined) ?? '/engine/stockfish-18-lite-single.js';

/** Stockfish(WASM) を Web Worker 上で動かすエンジン実装。 */
export class StockfishEngine implements ChessEngine {
  private worker: Worker | null = null;
  private url: string;

  constructor(url: string = DEFAULT_ENGINE_URL) {
    this.url = url;
  }

  async init(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(this.url);
    await this.handshake();
  }

  private post(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  /** 特定の文字列が来るまで待つ簡易ヘルパ。 */
  private waitFor(predicate: (line: string) => boolean, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) return reject(new Error('engine not initialized'));
      const timer = setTimeout(() => {
        worker.removeEventListener('message', onMsg);
        reject(new Error('engine timeout'));
      }, timeoutMs);
      const onMsg = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (predicate(line)) {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          resolve();
        }
      };
      worker.addEventListener('message', onMsg);
    });
  }

  private async handshake(): Promise<void> {
    this.post('uci');
    await this.waitFor((l) => l === 'uciok');
    this.post('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  async analyze(fen: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    if (!this.worker) await this.init();
    const worker = this.worker!;
    const depth = opts.depth ?? 14;
    const multipv = opts.multipv ?? 3;

    this.post(`setoption name MultiPV value ${multipv}`);
    this.post('ucinewgame');
    this.post(`position fen ${fen}`);

    const byMultipv = new Map<number, PvLine & { depth: number }>();

    return new Promise<AnalysisResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener('message', onMsg);
        reject(new Error('analyze timeout'));
      }, 60_000);

      const onMsg = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : '';
        const info = parseInfoLine(line);
        if (info) {
          byMultipv.set(info.multipv, info);
          return;
        }
        const best = parseBestMove(line);
        if (best !== null || line.startsWith('bestmove')) {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          const lines = [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
          resolve({
            fen,
            depth: lines[0]?.depth ?? depth,
            lines,
            bestMove: best ?? lines[0]?.moves[0] ?? null,
          });
        }
      };

      worker.addEventListener('message', onMsg);
      this.post(`go depth ${depth}`);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
