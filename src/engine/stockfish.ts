import type { AnalysisResult, PvLine } from '../core/types';
import type { AnalyzeOptions, ChessEngine, PlayOptions } from './types';
import { parseBestMove, parseInfoLine } from './uci';

/** 値を [min, max] に丸める。Skill Level(0-20) を範囲外指定から守る。 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const DEFAULT_ENGINE_URL =
  (import.meta.env.VITE_ENGINE_URL as string | undefined) ?? '/engine/stockfish-18-lite-single.js';

/** Stockfish(WASM) を Web Worker 上で動かすエンジン実装。 */
export class StockfishEngine implements ChessEngine {
  private worker: Worker | null = null;
  private url: string;
  /*
   * chooseMove の直列化チェーン。
   *
   * WHY 必要か(Codex 指摘の混線バグ対策):
   *   単一 worker では探索は同時に1つしか走らない。しかし chooseMove を並行に呼ぶと
   *   (例: AI 思考中に対局を中断して新規開始)、複数の "bestmove 待ち" listener が同じ
   *   worker に同時に張られる。worker が返す最初の bestmove は「前の探索(旧局面)」の結果でも、
   *   新しい chooseMove の listener がそれで resolve してしまい、旧局面の手が新局面に適用される。
   *   PlayView 側のキャンセルトークンは「適用段」は守るが、この「listener 段の取り違え」は防げない。
   *   → エンジン層で chooseMove を直列化し、常に listener を1つだけにして、各 go に対応する
   *      bestmove だけを受け取らせる。前の探索が bestmove を出し切る(drain)まで次の go を送らない。
   */
  private chooseChain: Promise<unknown> = Promise.resolve();

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

  /**
   * 対局用に1手を選ぶ(UCI、なければ null)。
   *
   * analyze() との違い:
   *   - MultiPV=1 に固定(候補は1本でよい。対局相手は1手指すだけ)。
   *   - Skill Level を毎回セット(前局面の設定が残っても上書きで確実に反映)。
   *   - go movetime を主に使い、体感速度を端末非依存に保つ。
   *
   * WHY ucinewgame を毎回送るか:
   *   前の局面のトランスポジションテーブルを引きずらせない。対局では局面ごとに
   *   独立して考えさせた方が、低 Skill のノイズが効いて弱さが安定する。
   *
   * WHY このエンジンインスタンスは対局専用にすべきか(呼び出し側の責務):
   *   単一 worker は analyze と chooseMove のメッセージを取り違えうる。PlayView は
   *   ReviewView と別の createEngine() インスタンスを持ち、chooseMove はターン制で
   *   直列化される(ユーザー着手→1回 chooseMove→適用)ため競合しない。
   */
  async chooseMove(fen: string, opts: PlayOptions = {}): Promise<string | null> {
    // 直列化: 前の chooseMove が settle するまで次を始めない(混線防止。上のフィールド注釈参照)。
    // chooseChain は常に catch 済みで fulfilled 状態なので then は必ず internal を実行する。
    const run = this.chooseChain.then(() => this.chooseMoveInternal(fen, opts));
    // 次段の基点は失敗しても resolved に落として、後続の chooseMove が止まらないようにする。
    this.chooseChain = run.catch(() => undefined);
    return run;
  }

  /** chooseMove の実処理(直列化ラッパ chooseMove からのみ呼ぶ)。 */
  private async chooseMoveInternal(fen: string, opts: PlayOptions = {}): Promise<string | null> {
    if (!this.worker) await this.init();
    const worker = this.worker!;
    const skill = clamp(Math.round(opts.skill ?? 20), 0, 20);

    this.post(`setoption name Skill Level value ${skill}`);
    this.post('setoption name MultiPV value 1');
    this.post('ucinewgame');
    this.post(`position fen ${fen}`);

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener('message', onMsg);
        // タイムアウト時は worker 内で古い探索が走り続けている可能性がある(Codex 指摘)。
        // 直列化は「正常完了で bestmove を出し切る=drain」を前提にしているが、timeout 経路は
        // drain されない。そのまま次の chooseMove を始めると、遅れて届く旧局面の bestmove が
        // 新しい listener を誤 resolve し、旧局面の手が新局面に入る。→ worker を破棄して縁を切り、
        // 次回 chooseMove の `if (!this.worker) await this.init()` で fresh な worker を作らせる。
        if (this.worker === worker) {
          worker.terminate();
          this.worker = null;
        }
        reject(new Error('chooseMove timeout'));
      }, 30_000);

      const onMsg = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : '';
        // bestmove 行だけを終了トリガにする(info 行は無視)。
        if (line.startsWith('bestmove')) {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          // parseBestMove は "bestmove (none)"(合法手なし=詰み/ステイルメイト)で null を返す。
          resolve(parseBestMove(line));
        }
      };

      worker.addEventListener('message', onMsg);
      // movetime 優先。未指定なら depth フォールバック(既定 12)。
      if (opts.movetimeMs && opts.movetimeMs > 0) {
        this.post(`go movetime ${Math.round(opts.movetimeMs)}`);
      } else {
        this.post(`go depth ${opts.depth ?? 12}`);
      }
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
