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

/*
 * 将棋用の駒価値（手番側視点センチポーン換算・粗い目安）。
 * WHY tsshogi を使わず SFEN 文字を直接数えるか（1バイト不変条件）:
 *   mock.ts は factory.ts から **静的 import** される＝メインチャンクに入る。ここで tsshogi を
 *   import すると将棋一式がチェス利用者のメインバンドルに漏れる（1バイト不変条件違反）。
 *   将棋の駒得はSFEN盤面文字列（駒アルファベット）を数えるだけで出せるので、tsshogi 非依存で実装する。
 *   値は「歩90 / 香桂300 / 銀金500 / 角飛900」程度の粗い近似（モックは弱さ制御せず駒得ベストのみ返す）。
 */
const SHOGI_PIECE_CP: Record<string, number> = {
  p: 90,
  l: 300,
  n: 300,
  s: 500,
  g: 500,
  b: 900,
  r: 1000,
  k: 0,
};

/**
 * SFEN の盤面部から手番側視点の駒得(cp)を計算する。持ち駒・成りは簡易に扱う
 * （成駒 "+p" 等は元駒価値で数える近似。モック用途では十分）。
 */
function shogiMaterialEval(sfen: string): number {
  const tokens = sfen.split(/\s+/);
  const board = tokens[0] ?? '';
  const turn = tokens[1] ?? 'b'; // 'b'=先手(black) / 'w'=後手(white)
  const hands = tokens[2] ?? '-';
  let black = 0; // 先手（大文字）
  let white = 0; // 後手（小文字）
  const addPiece = (ch: string) => {
    const lower = ch.toLowerCase();
    const v = SHOGI_PIECE_CP[lower];
    if (v === undefined) return;
    if (ch === ch.toUpperCase()) black += v;
    else white += v;
  };
  // 盤面: '+' は成り接頭辞なので読み飛ばして次の駒文字を数える。数字/'/' は空白/行区切り。
  for (let i = 0; i < board.length; i++) {
    const ch = board[i];
    if (ch === '+' || ch === '/' || (ch >= '1' && ch <= '9')) continue;
    addPiece(ch);
  }
  // 持ち駒: "2P3p" のように「数字?駒」の並び。数字は直後の駒の枚数。
  if (hands !== '-') {
    let count = 0;
    for (let i = 0; i < hands.length; i++) {
      const ch = hands[i];
      if (ch >= '0' && ch <= '9') {
        count = count * 10 + Number(ch);
        continue;
      }
      const v = SHOGI_PIECE_CP[ch.toLowerCase()];
      if (v !== undefined) {
        const n = count === 0 ? 1 : count;
        if (ch === ch.toUpperCase()) black += v * n;
        else white += v * n;
      }
      count = 0;
    }
  }
  const diff = black - white; // 先手視点の駒得
  return turn === 'b' ? diff : -diff; // 手番側視点に揃える
}

/**
 * WASM/coi 無しで動く決定的な将棋モックエンジン（テスト・coi不可環境用）。
 *
 * WHY 別クラスにするか:
 *   将棋は SFEN を受け、合法手ジェネレータ無し（tsshogi 非依存の制約）で最善手を出せない。
 *   よって bestMove=null・読み筋は駒得評価 1 本だけ返す簡易実装にする。ReviewView の解析ループは
 *   lines[0].score だけあれば「手の質分類」まで通るので、パイプライン疎通には十分。
 *   本物の解析はやねうら王(coi 環境)に任せ、これは fallback/テスト専用と割り切る。
 */
export class MockShogiEngine implements ChessEngine {
  async init(): Promise<void> {}

  async analyze(sfen: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const depth = opts.depth ?? 8;
    const cp = shogiMaterialEval(sfen);
    const lines: PvLine[] = [{ multipv: 1, score: { type: 'cp', value: cp } as Score, moves: [] }];
    // 合法手生成をしない＝最善手は提示できない（bestMove=null）。手の質は「損失=最善-実際」から
    // 計算されるが、モックでは最善が不明なので分類は目安（実解析はやねうら王が担う）。
    return { fen: sfen, depth, lines, bestMove: null };
  }

  async chooseMove(): Promise<string | null> {
    // 合法手生成が無いので着手は返せない（対局用途はやねうら王/coi 環境でのみ有効）。
    return null;
  }

  dispose(): void {}
}
