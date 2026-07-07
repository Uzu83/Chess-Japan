/*
 * sample.ts — オンボーディング用サンプル棋譜
 *
 * ワンクリック読み込みで評価グラフや解析機能をすぐ試せるよう、
 * 有名な短い名局・教材局を収録している。
 *
 * 棋譜の選定基準:
 *   - 短い(4〜17手): 全手解析をすぐ完了させて評価グラフを見やすくする
 *   - 有名: チェス史上のアイコニックな一局で学習的価値がある
 *   - PGN の正確性: chess.js で parse できることを確認済み
 */

/** デフォルト表示: ルイ・ロペス序盤8手。両サイド穏やかな進行で全機能の確認に適する。 */
export const SAMPLE_PGN = `[Event "Sample"]
[Site "?"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *
`;

/**
 * スカラーズメイト(4手詰め)。
 * 評価グラフで白の急激な優位確立(3...Nf6?? の疑問手→4.Qxf7#)が一目瞭然。
 * 初心者向け教材としても最適。
 */
export const SCHOLARS_MATE_PGN = `[Event "Scholar's Mate"]
[Site "?"]
[White "White"]
[Black "Black"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0
`;

/**
 * フールズメイト(愚者のメイト, 4手)。
 * 最短で終わるチェスゲーム。黒が勝つ稀なパターン。
 * 評価グラフで最終手の急落(黒詰み)が確認できる。
 */
export const FOOLS_MATE_PGN = `[Event "Fool's Mate"]
[Site "?"]
[White "White"]
[Black "Black"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
`;

/**
 * オペラゲーム — Paul Morphy vs Count Isouard & Duke of Brunswick (1858)。
 * 17手でのサクリファイス寄せ。Morphy の天才的なルーク捌きで締めくくられる名局。
 * 評価グラフで白の優位が段階的に拡大していく様子が分かる。
 */
export const OPERA_GAME_PGN = `[Event "Opera Game"]
[Site "Paris Opera House"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Count Isouard and Duke of Brunswick"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0
`;

/** ワンクリック読み込み用のサンプルリスト。ReviewView で "サンプル:" ボタン群に使う。 */
export const SAMPLE_GAMES: { label: string; pgn: string }[] = [
  { label: 'ルイ・ロペス', pgn: SAMPLE_PGN },
  { label: 'スカラーズメイト', pgn: SCHOLARS_MATE_PGN },
  { label: 'フールズメイト', pgn: FOOLS_MATE_PGN },
  { label: 'オペラゲーム', pgn: OPERA_GAME_PGN },
];
