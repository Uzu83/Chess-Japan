/*
 * notation.ts — UCI ↔ SAN 変換ユーティリティ(純関数)
 *
 * WHY 必要か:
 *   エンジンは手を UCI(座標式、例 "g1f3" / 成りは "e7e8q")で返す。これは正確だが人間には読みにくい。
 *   レビューUIでは SAN(標準代数式、例 "Nf3" / "e8=Q")で見せた方が一目で意味が分かる。
 *   特に「最善手は何で、その後どう進むのか(最善手順=PV)」を SAN で示せると、LLM 不要でも
 *   "何が最善で、なぜ良いか(この筋でこの評価になる)" を確定的に伝えられる。
 *
 * WHY 純関数に切り出すか:
 *   chess.js による変換は副作用がなく、局面(FEN)+UCI に対して決定的。vitest で回帰できる。
 *   ExplanationPanel など UI から呼ぶが、ロジックは core に置いて表示層から独立させる。
 */

import { Chess } from 'chess.js';

/**
 * ある局面(fen)における UCI 1手を SAN に変換する。変換不能(不正手/不正FEN)は null。
 *
 * 例: uciToSan(startpos, "g1f3") === "Nf3"
 * 成り: "e7e8q" → "e8=Q"(その局面で合法なら)
 */
export function uciToSan(fen: string, uci: string): string | null {
  if (!uci || uci.length < 4) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      // 5文字目があれば成り駒(q/r/b/n)。無ければ undefined。
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move ? move.san : null;
  } catch {
    // chess.js は不正手で例外を投げる版があるため握って null に統一。
    return null;
  }
}

/**
 * UCI の手順(読み筋 PV)を、開始局面 fen から順に適用して SAN 列に変換する。
 *
 * - maxPlies で表示用に打ち切る(PV は長くなりがちで、UI には数手あれば十分)。
 * - 途中で不正手/変換不能に当たったら、そこまでの SAN を返す(壊れた PV でも安全)。
 *
 * WHY 途中打ち切りを許すか:
 *   エンジンの PV は稀に末尾が欠けたり局面と不整合な手を含むことがある。全部変換できないと
 *   ゼロ返しにするより、「変換できたところまで」見せた方がユーザーに有益(部分的でも筋は伝わる)。
 */
export function uciLineToSan(fen: string, uciMoves: string[], maxPlies = 6): string[] {
  const out: string[] = [];
  try {
    const chess = new Chess(fen);
    for (let i = 0; i < uciMoves.length && i < maxPlies; i++) {
      const u = uciMoves[i];
      if (!u || u.length < 4) break;
      const mv = chess.move({
        from: u.slice(0, 2),
        to: u.slice(2, 4),
        promotion: u.length > 4 ? u[4] : undefined,
      });
      if (!mv) break;
      out.push(mv.san);
    }
  } catch {
    // 途中で例外 → そこまでの手を返す
  }
  return out;
}
