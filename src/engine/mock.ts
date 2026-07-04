import { Chess } from 'chess.js';
import type { AnalysisResult, PvLine, Score } from '../core/types';
import type { AnalyzeOptions, ChessEngine } from './types';

const PIECE_CP: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** 局面の駒得を手番側視点のセンチポーンで返す。 */
function materialEval(chess: Chess): number {
  const board = chess.board();
  let white = 0;
  let black = 0;
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_CP[sq.type];
      if (sq.color === 'w') white += v;
      else black += v;
    }
  }
  const diff = white - black;
  return chess.turn() === 'w' ? diff : -diff;
}

/** 文字列から安定した小さな揺らぎ値を作る(決定的)。 */
function jitter(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 21) - 10; // -10..+10
}

/**
 * WASM 無しで動く決定的モックエンジン。駒得ベースの簡易評価。
 * パイプライン/UI を実ブラウザのエンジン無しで通すための開発用。
 */
export class MockEngine implements ChessEngine {
  async init(): Promise<void> {}

  async analyze(fen: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const multipv = opts.multipv ?? 3;
    const depth = opts.depth ?? 12;
    const chess = new Chess(fen);
    const legal = chess.moves({ verbose: true });
    const scored = legal.map((m) => {
      const next = new Chess(fen);
      next.move(m.san);
      // 相手番視点の評価を反転して手番側視点に
      const moverEval = -materialEval(next) + jitter(m.lan);
      return { uci: m.lan, cp: moverEval };
    });

    scored.sort((a, b) => b.cp - a.cp);
    const top = scored.slice(0, multipv);

    const lines: PvLine[] = top.map((s, i) => ({
      multipv: i + 1,
      score: { type: 'cp', value: s.cp } as Score,
      moves: [s.uci],
    }));

    return {
      fen,
      depth,
      lines,
      bestMove: top[0]?.uci ?? null,
    };
  }

  /**
   * 対局用の着手。Skill Level(弱さ調整)は無視し、駒得ベストの手を返す(決定的)。
   * WASM 不在の開発環境や jsdom テストで AI 戦フローを通すためのフォールバック。
   *
   * WHY PlayOptions を引数に取らないか:
   *   モックは弱さ調整をしないので opts を使わない。使わない引数を書くと no-unused-vars に
   *   引っかかるため、末尾 optional 引数を省略する(TS 的に interface へ代入可能=適合)。
   */
  async chooseMove(fen: string): Promise<string | null> {
    const result = await this.analyze(fen, { multipv: 1 });
    return result.bestMove;
  }

  dispose(): void {}
}
