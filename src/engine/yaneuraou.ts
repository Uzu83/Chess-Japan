/*
 * yaneuraou.ts — やねうら王(@mizarjp/yaneuraou.k-p, WASM/NNUE 水匠内蔵) の将棋エンジン制御
 *
 * WHY 動的 import 到達専用か（1バイト不変条件）:
 *   このモジュールは将棋エンジン一式（~490KB 相当のグルー参照 + wasm）に繋がる。チェス利用者に
 *   払わせないため factory.ts の createShogiEngine から **動的 import** でのみ読み込む。
 *   メインチャンクに静的に含めてはならない。
 *
 * WHY stockfish.ts の構造を踏襲するか（Codex ゲート①）:
 *   探索は単一エンジンで同時に 1 本。stockfish.ts が確立した「直列化チェーン + timeout→terminate で
 *   縁を切る」不変条件（混線した bestmove で旧局面の手が新局面に入る事故の防止）は将棋でも同じ。
 *   ただし転送は Web Worker ではなく Emscripten モジュール（addMessageListener/postMessage/terminate）。
 *   グルーが内部で pthread ワーカーを起こすため、こちらは module を 1 つ管理する。
 *
 * WHY crossOriginIsolated 必須の明示エラーか（Codex ゲート① 合意 (b)・Phase 4-0 実測）:
 *   k-p は pthread ビルドで SharedArrayBuffer を要求する＝crossOriginIsolated が真でないと動かない。
 *   Chromium は COEP credentialless で真になるが、**WebKit(Safari) は credentialless 非対応**で偽のまま
 *   （2026 時点でも実測 FAIL）。ここで黙って落ちると原因不明のハングになるため、init で明示的に
 *   例外を投げ、UI 側で「この局面は閲覧のみ・エンジン解析は非対応」と案内できるようにする。
 *
 * ライセンス: やねうら王/評価関数は GPL-3.0。wasm/js/worker と Copying(GPL) は copy-engine.mjs で
 *   public/engine-shogi/ へ配布し、README にソース入手先を明記（Stockfish と同型の再配布要件）。
 */

import type { AnalysisResult, PvLine } from '../core/types';
import type { AnalyzeOptions, ChessEngine, PlayOptions } from './types';
import { parseInfoLine, parseUsiBestMove } from './usi';

/** 値を [min, max] に丸める。SkillLevel(0-20) 等を範囲外指定から守る。 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * グルー(yaneuraou.k-p.js)の配置 URL。既定は copy-engine.mjs が置く public/engine-shogi/。
 * VITE_SHOGI_ENGINE_URL で差し替え可能（テスト/CDN 配信の逃げ道）。
 */
const DEFAULT_GLUE_URL =
  (import.meta.env.VITE_SHOGI_ENGINE_URL as string | undefined) ?? '/engine-shogi/yaneuraou.k-p.js';

/** グルーが公開する Emscripten モジュールの最小面（必要なメソッドだけ型付け）。 */
interface YaneuraOuModule {
  addMessageListener(listener: (line: string) => void): void;
  removeMessageListener(listener: (line: string) => void): void;
  postMessage(command: string): void;
  terminate(): void;
}
/** グルーが window に生やすファクトリ。overrides.locateFile で wasm/worker の解決先を固定する。 */
type YaneuraOuFactory = (overrides?: {
  locateFile?: (path: string) => string;
}) => Promise<YaneuraOuModule>;

declare global {
  interface Window {
    // グルーは UMD 形式で `var YaneuraOu_K_P` をグローバルに生やす（スパイク test.html で確認）。
    YaneuraOu_K_P?: YaneuraOuFactory;
  }
}

/** グルー <script> は 1 度だけ注入して factory を使い回す（多重注入防止）。 */
let gluePromise: Promise<YaneuraOuFactory> | null = null;
function loadGlue(url: string): Promise<YaneuraOuFactory> {
  if (window.YaneuraOu_K_P) return Promise.resolve(window.YaneuraOu_K_P);
  if (gluePromise) return gluePromise;
  gluePromise = new Promise<YaneuraOuFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    // onload 時点で document.currentScript=この script なので、グルー内部の _scriptDir は
    // /engine-shogi/ を指し、wasm/worker.js を同ディレクトリから解決できる（locateFile でも上書きする）。
    script.onload = () => {
      if (window.YaneuraOu_K_P) resolve(window.YaneuraOu_K_P);
      else reject(new Error('YaneuraOu factory not found after glue load'));
    };
    script.onerror = () => {
      gluePromise = null; // 失敗したら次回リトライできるようキャッシュを捨てる
      reject(new Error('failed to load shogi engine glue script'));
    };
    document.head.appendChild(script);
  });
  return gluePromise;
}

/** locateFile: グルーが要求する相対パス(wasm/worker.js)を配布ディレクトリへ絶対解決する。 */
function locateFileFrom(glueUrl: string): (path: string) => string {
  // glueUrl のディレクトリ部分（例 "/engine-shogi/"）を基点にする。
  const base = glueUrl.slice(0, glueUrl.lastIndexOf('/') + 1);
  return (path: string) => base + path;
}

/** crossOriginIsolated（=SAB 有効）か。Safari(credentialless 非対応)では false。 */
function isCrossOriginIsolated(): boolean {
  return typeof globalThis !== 'undefined' && globalThis.crossOriginIsolated === true;
}

/** やねうら王(WASM) を Emscripten モジュール越しに動かす将棋エンジン実装（ChessEngine 面を共用）。 */
export class YaneuraOuEngine implements ChessEngine {
  private module: YaneuraOuModule | null = null;
  private url: string;
  // chooseMove の直列化チェーン（stockfish.ts と同一思想の混線防止。詳細はそちらの注釈参照）。
  private chooseChain: Promise<unknown> = Promise.resolve();

  constructor(url: string = DEFAULT_GLUE_URL) {
    this.url = url;
  }

  async init(): Promise<void> {
    if (this.module) return;
    // Safari 等の非対応ブラウザは SAB が無く pthread ビルドが起動しない。明示エラーで UI にフォールバックさせる。
    if (!isCrossOriginIsolated()) {
      throw new Error(
        'shogi engine requires crossOriginIsolated (SharedArrayBuffer). ' +
          'このブラウザ(例: Safari)は将棋エンジン解析に未対応です。',
      );
    }
    const factory = await loadGlue(this.url);
    this.module = await factory({ locateFile: locateFileFrom(this.url) });
    await this.handshake();
  }

  private post(cmd: string): void {
    this.module?.postMessage(cmd);
  }

  /** 特定の述語を満たす行が来るまで待つ簡易ヘルパ（timeout つき）。 */
  private waitFor(predicate: (line: string) => boolean, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const mod = this.module;
      if (!mod) return reject(new Error('engine not initialized'));
      const timer = setTimeout(() => {
        mod.removeMessageListener(onMsg);
        reject(new Error('engine timeout'));
      }, timeoutMs);
      const onMsg = (line: string) => {
        if (predicate(line)) {
          clearTimeout(timer);
          mod.removeMessageListener(onMsg);
          resolve();
        }
      };
      mod.addMessageListener(onMsg);
    });
  }

  private async handshake(): Promise<void> {
    // 【地雷・Playwright 実測で確定(2026-07-08)】mizar グルーはリスナー未装着時の出力行を
    // バッファせず捨てる上、postMessage の応答は「postMessage 実行中に同期的に」リスナーへ
    // 配送されうる。つまり `post('usi') → waitFor(...)` の順に書くと、同一同期ブロック内でも
    // usiok を取り逃して 60 秒タイムアウト → モックにフォールバックする（実測:
    // post先=timeout / listener先=usiok。同一ページ・同一 locateFile で再現）。
    // よって応答を待つコマンドは必ず「waitFor を先に arm してから post する」こと。
    // analyze()/chooseMoveInternal() の go も同じ理由でリスナー装着後に post している。
    const usiok = this.waitFor((l) => l === 'usiok', 60_000);
    this.post('usi');
    await usiok;
    // WHY 定跡を明示 off にするか（Phase 4-0 実測: USI_OwnBook default=true）:
    //   1手解説の目的は「その局面でのエンジン最善」を見せること。定跡DBの手を返されると
    //   探索評価と解説がズレる。BookFile=no_book でも実質無効だが、二重に off を明示して意図を固定。
    this.post('setoption name USI_OwnBook value false');
    // ブラウザメモリ保護: 置換表を控えめに（1手解析に巨大ハッシュは不要。default 1024MB は端末を圧迫しうる）。
    this.post('setoption name USI_Hash value 48');
    // 安定性優先で 1 スレッド固定（pthread ビルドだが分岐競合の切り分けを容易にする。速度が要れば将来上げる）。
    this.post('setoption name Threads value 1');
    const readyok = this.waitFor((l) => l === 'readyok', 60_000);
    this.post('isready');
    await readyok;
  }

  /** 局面(SFEN)を解析する。振り返り用＝常に最善を尽くさせる（SkillLevel 満点・NodesLimit 解除）。 */
  async analyze(sfen: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    if (!this.module) await this.init();
    const mod = this.module!;
    const depth = opts.depth ?? 12;
    const multipv = opts.multipv ?? 3;

    // 解析は全力: 弱さレバー(SkillLevel/NodesLimit)を毎回リセットしてから探索する
    // （同一インスタンスを将来 chooseMove と共用しても、前回の弱さ設定を引きずらせない）。
    this.post('setoption name SkillLevel value 20');
    this.post('setoption name NodesLimit value 0');
    this.post(`setoption name MultiPV value ${multipv}`);
    this.post('usinewgame');
    this.post(`position sfen ${sfen}`);

    const byMultipv = new Map<number, PvLine & { depth: number }>();

    return new Promise<AnalysisResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        mod.removeMessageListener(onMsg);
        reject(new Error('analyze timeout'));
      }, 60_000);

      const onMsg = (line: string) => {
        const info = parseInfoLine(line);
        if (info) {
          byMultipv.set(info.multipv, info);
          return;
        }
        if (line.startsWith('bestmove')) {
          clearTimeout(timer);
          mod.removeMessageListener(onMsg);
          const lines = [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
          // bestmove resign/win/none は「実手なし」なので bestMove=null（詰み/投了局面など）。
          const bm = parseUsiBestMove(line);
          const bestFromLine = bm?.kind === 'move' ? bm.usi : null;
          resolve({
            fen: sfen,
            depth: lines[0]?.depth ?? depth,
            lines,
            bestMove: bestFromLine ?? lines[0]?.moves[0] ?? null,
          });
        }
      };

      mod.addMessageListener(onMsg);
      this.post(`go depth ${depth}`);
    });
  }

  /**
   * 対局用に 1 手を選ぶ（Phase 4-2 の AI 対局向け。4-1 のレビューでは未使用）。
   * 弱さ制御: SkillLevel + NodesLimit を併用（Phase 4-0 スパイクで両オプション実在を確認）。
   *
   * 戻り値は ChessEngine 契約に合わせ string | null。resign/win/none は「盤に置ける実手なし」として
   * null に丸める（"resign" 等を指し手文字列として流さない＝usi.ts の UsiBestMove 分離の意図を守る）。
   */
  async chooseMove(sfen: string, opts: PlayOptions = {}): Promise<string | null> {
    const run = this.chooseChain.then(() => this.chooseMoveInternal(sfen, opts));
    this.chooseChain = run.catch(() => undefined);
    return run;
  }

  private async chooseMoveInternal(sfen: string, opts: PlayOptions = {}): Promise<string | null> {
    if (!this.module) await this.init();
    const mod = this.module!;
    const skill = clamp(Math.round(opts.skill ?? 20), 0, 20);

    this.post(`setoption name SkillLevel value ${skill}`);
    // NodesLimit で探索量も絞ると弱さがより安定する（SkillLevel 単独より人間的な取りこぼしが出る）。
    // skill=20(全力)のときは 0=無制限。弱くするほどノード数を絞る（下限 10000 で最低限の合法性は担保）。
    const nodes = skill >= 20 ? 0 : Math.max(10_000, skill * 20_000);
    this.post(`setoption name NodesLimit value ${nodes}`);
    this.post('setoption name MultiPV value 1');
    this.post('usinewgame');
    this.post(`position sfen ${sfen}`);

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        mod.removeMessageListener(onMsg);
        // timeout 経路は探索が drain されない。stockfish.ts と同様に module を破棄して縁を切り、
        // 次回 init で作り直させる（遅れて届く旧局面 bestmove の誤 resolve を断つ）。
        if (this.module === mod) {
          mod.terminate();
          this.module = null;
        }
        reject(new Error('chooseMove timeout'));
      }, 30_000);

      const onMsg = (line: string) => {
        if (line.startsWith('bestmove')) {
          clearTimeout(timer);
          mod.removeMessageListener(onMsg);
          const bm = parseUsiBestMove(line);
          resolve(bm?.kind === 'move' ? bm.usi : null);
        }
      };

      mod.addMessageListener(onMsg);
      if (opts.movetimeMs && opts.movetimeMs > 0) {
        this.post(`go movetime ${Math.round(opts.movetimeMs)}`);
      } else {
        this.post(`go depth ${opts.depth ?? 10}`);
      }
    });
  }

  dispose(): void {
    this.module?.terminate();
    this.module = null;
  }
}
