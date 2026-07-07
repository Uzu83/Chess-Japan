import { describe, it, expect } from 'vitest';
import { PlayGame, opposite } from './playGame';

/*
 * playGame.test.ts — 対局コントローラの回帰テスト
 *
 * WHY ここを厚くテストするか:
 *   着手の合法性・勝敗判定・成り・投了は「対局として成立するか」の根幹。
 *   ここが壊れると AI 戦全体が破綻するので、全分岐を決定的な入力で固定する。
 */

describe('PlayGame — 初期状態と基本着手', () => {
  it('初期局面は白番・続行中・0手', () => {
    const g = new PlayGame();
    const s = g.snapshot();
    expect(s.turn).toBe('white');
    expect(s.outcome.over).toBe(false);
    expect(s.moveCount).toBe(0);
    expect(s.lastMoveUci).toBeNull();
  });

  it('合法手 dests に e2→e4 が含まれる', () => {
    const g = new PlayGame();
    const dests = g.legalDests();
    expect(dests.get('e2')).toContain('e4');
    expect(dests.get('e2')).toContain('e3');
  });

  it('合法手を指すと手番が変わり lastMove が更新される', () => {
    const g = new PlayGame();
    const mv = g.move('e2', 'e4');
    expect(mv).not.toBeNull();
    expect(mv?.san).toBe('e4');
    expect(mv?.uci).toBe('e2e4');
    expect(g.turn).toBe('black');
    expect(g.moveCount).toBe(1);
    expect(g.lastMoveUci()).toBe('e2e4');
  });

  it('非合法手は null を返し状態を変えない', () => {
    const g = new PlayGame();
    const mv = g.move('e2', 'e5'); // ポーンは2マスまで(e2→e5 は不可)
    expect(mv).toBeNull();
    expect(g.moveCount).toBe(0);
    expect(g.turn).toBe('white');
  });

  it('undo で直近手を戻せる', () => {
    const g = new PlayGame();
    g.move('e2', 'e4');
    expect(g.undo()).toBe(true);
    expect(g.moveCount).toBe(0);
    expect(g.turn).toBe('white');
    // 手が無い状態での undo は false
    expect(g.undo()).toBe(false);
  });
});

describe('PlayGame — 勝敗判定', () => {
  it('フールズメイトで黒の勝ち(詰み)', () => {
    const g = new PlayGame();
    g.move('f2', 'f3');
    g.move('e7', 'e5');
    g.move('g2', 'g4');
    g.move('d8', 'h4'); // Qh4#
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('checkmate');
      expect(o.winner).toBe('black');
    }
    expect(g.resultToken()).toBe('0-1');
  });

  it('ステイルメイトは引き分け(winner=null)', () => {
    // 黒番: 黒K h8、白Q f7、白K g6。黒に合法手なし・王手でない。
    const g = new PlayGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('stalemate');
      expect(o.winner).toBeNull();
    }
    expect(g.resultToken()).toBe('1/2-1/2');
  });

  it('K対K は駒不足で引き分け', () => {
    const g = new PlayGame('8/8/8/4k3/8/4K3/8/8 w - - 0 1');
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) expect(o.reason).toBe('insufficient');
  });

  it('終局後は move() が着手を拒否する(不変条件)', () => {
    const g = new PlayGame();
    g.move('f2', 'f3');
    g.move('e7', 'e5');
    g.move('g2', 'g4');
    g.move('d8', 'h4'); // Qh4# で終局
    expect(g.outcome().over).toBe(true);
    const before = g.moveCount;
    // 終局後に合法な形の手を送っても拒否され、棋譜は変異しない
    const rejected = g.move('e1', 'e2');
    expect(rejected).toBeNull();
    expect(g.moveCount).toBe(before);
  });

  it('投了後の move() も拒否されるが、undo()/待ったは通る', () => {
    const g = new PlayGame();
    g.move('e2', 'e4');
    g.move('e7', 'e5');
    g.resign('white');
    // 投了で終局 → 着手拒否
    expect(g.move('g1', 'f3')).toBeNull();
    // 待ったの低レベル操作(clearResign + undo)は move() を通らないので機能する
    g.clearResign();
    expect(g.undo()).toBe(true); // e5(黒)を戻す → 黒番に戻る
    expect(g.outcome().over).toBe(false);
    // 巻き戻し後は再び着手できる(黒番なので黒の合法手)
    expect(g.move('b8', 'c6')).not.toBeNull();
  });

  it('投了すると相手の勝ち', () => {
    const g = new PlayGame();
    g.move('e2', 'e4');
    g.resign('white');
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('resign');
      expect(o.winner).toBe('black');
    }
    expect(g.resultToken()).toBe('0-1');
    // clearResign で終局を巻き戻せる
    g.clearResign();
    expect(g.outcome().over).toBe(false);
  });
});

describe('PlayGame — 成り', () => {
  it('needsPromotion がポーンの最終段到達を検出する', () => {
    // 白ポーン a7、成れば a8。
    const g = new PlayGame('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(g.needsPromotion('a7', 'a8')).toBe(true);
    // 通常の手は成り不要
    const g2 = new PlayGame();
    expect(g2.needsPromotion('e2', 'e4')).toBe(false);
  });

  it('成り先の駒種を指定できる(アンダープロモーション)', () => {
    const g = new PlayGame('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const mv = g.move('a7', 'a8', 'n'); // ナイト成り
    expect(mv).not.toBeNull();
    expect(mv?.uci).toBe('a7a8n');
    expect(mv?.san).toContain('N');
  });

  it('成りマスの dests は重複除去され1エントリになる', () => {
    const g = new PlayGame('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const dests = g.legalDests();
    // a7→a8 は q/r/b/n の4手あるが、行き先集合としては 'a8' 1つだけ
    const a7 = dests.get('a7') ?? [];
    expect(a7.filter((d) => d === 'a8')).toHaveLength(1);
  });
});

describe('PlayGame — PGN 出力', () => {
  it('ヘッダと Result 付きの PGN を出力し、指し手を含む', () => {
    const g = new PlayGame();
    g.move('e2', 'e4');
    g.move('e7', 'e5');
    g.resign('black');
    const pgn = g.pgn({ White: 'You', Black: 'AI (ふつう)' });
    expect(pgn).toContain('e4');
    expect(pgn).toContain('e5');
    expect(pgn).toContain('[White "You"]');
    expect(pgn).toContain('1-0'); // 黒投了 → 白勝ち
  });
});

describe('opposite', () => {
  it('色を反転する', () => {
    expect(opposite('white')).toBe('black');
    expect(opposite('black')).toBe('white');
  });
});

describe('PlayGame — カスタム開始局面(Phase 2B)', () => {
  // 1.e4 e5 の後の局面から対局を始めるケース。
  // アンパッサン欄は '-'(chess.js は「実際に取れない ep」を '-' に正規化するため、
  // 'e6' と書くと fen 往復で不一致になる — 正規形で書くのが正解)。
  const MID_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

  it('startFen から開始でき、手番が FEN 通りになる', () => {
    const g = new PlayGame(MID_FEN);
    expect(g.turn).toBe('white');
    expect(g.fen).toBe(MID_FEN);
  });

  it('PGN に SetUp/FEN ヘッダが付き、ChessGame.fromPgn で振り返れる(往復)', async () => {
    const g = new PlayGame(MID_FEN);
    g.move('g1', 'f3');
    g.move('b8', 'c6');
    const pgn = g.pgn({ Event: 'AI 戦' });
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain(`[FEN "${MID_FEN}"]`);
    // 振り返り側(ChessGame)が正しくカスタム開始局面として読めること
    const { ChessGame } = await import('./game');
    const review = ChessGame.fromPgn(pgn);
    expect(review.startFen).toBe(MID_FEN);
    expect(review.moves[0].san).toBe('Nf3');
  });

  it('標準初期配置を明示的に渡しても SetUp/FEN ヘッダは付かない', () => {
    const g = new PlayGame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    g.move('e2', 'e4');
    const pgn = g.pgn();
    expect(pgn).not.toContain('[SetUp');
  });
});
