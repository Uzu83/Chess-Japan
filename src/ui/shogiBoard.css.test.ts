// CSS を生テキストとして読み込む（Vite の ?raw。vite/client が型を提供・jsdom を通さない）。
import css from './shogiBoard.css?raw';

/*
 * shogiBoard.css の「駒の向き」回帰ガード（2026-07-09 バグ「駒の漢字が双方逆」再発防止）。
 *
 * WHY 文字列で固定するか: 駒グリフの 180° 回転は CSS の ::after transform で行うが、jsdom は
 *   CSS transform を計算しない（getComputedStyle でも解決されない）ため、実効的な向きは単体テストで
 *   検証できない。そこで「ルールが orientation×色 で定義されている」ことをソース文字列で固定し、
 *   ①色だけで回す旧ルール（盤の向きに追従せず双方逆になる）への退行 ②orientation 対応ルールの消失
 *   を検出する。実効的な向きの目視は E2E スクショで担保する（コメントに明記した3点検証）。
 */
describe('shogiBoard.css 駒の向き（回帰ガード）', () => {
  it('回転は orientation×色 の組で決め、rotate(180deg) が同一ルールに結合している', () => {
    // Codex ゲート② F002: セレクタ行の存在だけでなく、その rule block に rotate(180deg) が
    // 入っていることまで固定する（rotate が消えても selector が残ればすり抜ける退行を防ぐ）。
    // 先手向き（既定）は後手(上)を、後手向き（盤反転・後手番/後手 SFEN 開始）は先手(上)を回す。
    // この2セレクタが1つのルール（カンマ結合）で { ... transform: rotate(180deg) ... } を持つことを検証。
    const coupledRule =
      /\.sg-wrap\.orientation-sente\s+sg-pieces\s+piece\.gote::after\s*,\s*\.sg-wrap\.orientation-gote\s+sg-pieces\s+piece\.sente::after\s*\{[^}]*transform:\s*rotate\(180deg\)[^}]*\}/;
    expect(css).toMatch(coupledRule);
  });

  it('色だけで回す旧ルール（orientation 非依存）が残っていない', () => {
    // `.sg-wrap sg-pieces piece.gote::after { ... rotate ... }` のような orientation 修飾の無い
    // 色単独ルールは、盤の向きに追従せず双方逆転を招く退行の兆候。存在しないことを固定する。
    const colorOnlyRotate = /\.sg-wrap\s+sg-pieces\s+piece\.(gote|sente)::after\s*\{[^}]*rotate/;
    expect(css).not.toMatch(colorOnlyRotate);
  });
});
