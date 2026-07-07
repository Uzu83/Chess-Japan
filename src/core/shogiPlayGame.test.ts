import { ShogiPlayGame } from './shogiPlayGame';
import { shogiGameModel } from './shogiGame';

/*
 * shogiPlayGame.test.ts — 将棋対局コントローラの回帰テスト
 *
 * 期待値は Phase 4-2 準備で node 実測（scratchpad/verify-play.mjs / verify-promo.mjs）した
 * tsshogi の挙動に基づく。詰み/千日手/連続王手の各 SFEN・手順は実測 PASS 済みの構築物。
 * playGame.test.ts（chess）と同じ観点（着手/非合法拒否/終局後拒否/終局判定/undo/棋譜往復）を将棋へ写す。
 */

const STANDARD_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('ShogiPlayGame 基本', () => {
  it('初期状態は先手番・0手・標準初期局面・続行中', () => {
    const g = new ShogiPlayGame();
    expect(g.turn).toBe('sente');
    expect(g.moveCount).toBe(0);
    expect(g.sfen).toBe(STANDARD_SFEN);
    expect(g.outcome().over).toBe(false);
    expect(g.lastMoveUsi()).toBeNull();
  });

  it('合法手を着手すると手番が移り履歴が増える', () => {
    const g = new ShogiPlayGame();
    expect(g.move('7g', '7f')).toBe(true);
    expect(g.turn).toBe('gote');
    expect(g.moveCount).toBe(1);
    expect(g.lastMoveUsi()).toBe('7g7f');
    const h = g.history();
    expect(h[0].usi).toBe('7g7f');
    expect(h[0].label).toBe('☗７六歩'); // tsshogi の日本語表記
    expect(h[0].color).toBe('sente');
  });

  it('非合法手は拒否され状態は不変', () => {
    const g = new ShogiPlayGame();
    // 歩は2マス跳べない
    expect(g.move('7g', '7e')).toBe(false);
    expect(g.moveCount).toBe(0);
    expect(g.turn).toBe('sente');
  });

  it('legalDests は from→to[] を返す（初手の歩・桂・角道など）', () => {
    const g = new ShogiPlayGame();
    const d = g.legalDests();
    expect(d.get('7g')).toContain('7f'); // ７六歩
    expect(d.get('1g')).toContain('1f'); // 端歩
    // 初形は持ち駒が無いので dropDests は空
    expect(g.dropDests().size).toBe(0);
  });
});

describe('ShogiPlayGame 成り', () => {
  it('成れるが強制でない手は needsPromotionChoice=true', () => {
    // 5d の歩が 5c（敵陣）へ入る＝成/不成どちらも合法
    const g = new ShogiPlayGame('k8/9/9/4P4/9/9/9/9/K8 b - 1');
    expect(g.needsPromotionChoice('5d', '5c')).toBe(true);
  });

  it('行き所のない駒は強制成り（needsPromotionChoice=false・move は自動成り）', () => {
    // 5b の歩が最終段 5a へ。不成は非合法なので選択不要＝自動で成る。
    const g = new ShogiPlayGame('k8/4P4/9/9/9/9/9/9/K8 b - 1');
    expect(g.needsPromotionChoice('5b', '5a')).toBe(false);
    expect(g.move('5b', '5a')).toBe(true); // promote 未指定でも成りに倒す
    expect(g.lastMoveUsi()).toBe('5b5a+');
  });

  it('promote=false で強制成りの手を指すと非合法として拒否', () => {
    const g = new ShogiPlayGame('k8/4P4/9/9/9/9/9/9/K8 b - 1');
    expect(g.move('5b', '5a', false)).toBe(false);
    expect(g.moveCount).toBe(0);
  });
});

describe('ShogiPlayGame 打ち', () => {
  // 打ち歩詰めの局面: 5a 玉・5c 銀(歩の受け)・4i/6i 香(4a/6a を封鎖)・先手持ち歩1。
  const UCHIFUZUME = '4k4/9/4S4/9/9/9/9/9/3L1L2K b P 1';

  it('通常の持ち駒打ちは成功する', () => {
    const g = new ShogiPlayGame(UCHIFUZUME);
    expect(g.drop('pawn', '5e')).toBe(true);
    expect(g.lastMoveUsi()).toBe('P*5e');
  });

  it('打ち歩詰めは禁じ手として拒否（tsshogi が弾く）', () => {
    const g = new ShogiPlayGame(UCHIFUZUME);
    expect(g.drop('pawn', '5b')).toBe(false);
    expect(g.moveCount).toBe(0);
  });

  it('dropDests は打てるマスだけを返す（打ち歩詰めのマスは含まない）', () => {
    const g = new ShogiPlayGame(UCHIFUZUME);
    const dd = g.dropDests();
    const pawnTos = dd.get('pawn') ?? [];
    expect(pawnTos).toContain('5e');
    expect(pawnTos).not.toContain('5b'); // 打ち歩詰めは除外
  });
});

describe('ShogiPlayGame 終局判定', () => {
  it('詰み: 手番側に合法手が無ければ相手の勝ち', () => {
    // 5a 玉(後手)・5b 金(先手・王手)・5c 玉(先手・金を守る)＝頭金の詰み。後手番。
    const g = new ShogiPlayGame('4k4/4G4/4K4/9/9/9/9/9/9 w - 1');
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('checkmate');
      expect(o.winner).toBe('sente');
    }
    // 終局後は着手を拒否する（不変条件）
    expect(g.move('5a', '6a')).toBe(false);
  });

  it('千日手: 同一局面4回で引き分け（連続王手でない）', () => {
    const g = new ShogiPlayGame('4k4/9/9/9/9/9/9/9/4K4 b - 1');
    // 両者の玉が 5筋↔4筋 を往復（4サイクル＝12手で同一局面が4回目）
    for (const u of [
      '5i4i',
      '5a4a',
      '4i5i',
      '4a5a', //
      '5i4i',
      '5a4a',
      '4i5i',
      '4a5a',
      '5i4i',
      '5a4a',
      '4i5i',
      '4a5a',
    ]) {
      expect(g.move(u.slice(0, 2), u.slice(2, 4))).toBe(true);
    }
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('repetition');
      expect(o.winner).toBeNull();
    }
  });

  it('連続王手の千日手: 王手をかけ続けた側（先手）の負け', () => {
    // 5c 飛(先手)で王手を継続。前置き 1 手(5c5b)で反復局面を ply0 以外から始める
    // （ply0=初期局面から反復させると tsshogi の perpetualCheck 判定が START ノードで崩れるため）。
    const g = new ShogiPlayGame('4k4/9/4R4/9/9/9/9/9/8K b - 1');
    for (const u of [
      '5c5b', // 前置き（初回の王手局面を作る）
      '5a6a',
      '5b6b',
      '6a5a',
      '6b5b',
      '5a6a',
      '5b6b',
      '6a5a',
      '6b5b',
      '5a6a',
      '5b6b',
      '6a5a',
      '6b5b',
    ]) {
      expect(g.move(u.slice(0, 2), u.slice(2, 4))).toBe(true);
    }
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('perpetualCheck');
      expect(o.winner).toBe('gote'); // 先手が王手継続＝先手の負け
    }
  });

  it('投了: resign した側の相手が勝ち。clearResign で続行に戻る', () => {
    const g = new ShogiPlayGame();
    g.move('7g', '7f');
    g.resign('gote');
    const o = g.outcome();
    expect(o.over).toBe(true);
    if (o.over) {
      expect(o.reason).toBe('resign');
      expect(o.winner).toBe('sente');
    }
    // 終局後は着手拒否
    expect(g.move('3c', '3d')).toBe(false);
    g.clearResign();
    expect(g.outcome().over).toBe(false);
  });
});

describe('ShogiPlayGame 待った(undo)', () => {
  it('直近手を取り消すと手数が減り、棋譜からも消える', () => {
    const g = new ShogiPlayGame();
    g.move('7g', '7f');
    g.move('3c', '3d');
    expect(g.moveCount).toBe(2);
    expect(g.undo()).toBe(true);
    expect(g.moveCount).toBe(1);
    expect(g.turn).toBe('gote'); // 2手目を戻したので再び後手番
    // 0手まで戻したらそれ以上は戻せない
    expect(g.undo()).toBe(true);
    expect(g.moveCount).toBe(0);
    expect(g.undo()).toBe(false);
  });
});

describe('ShogiPlayGame KIF 往復', () => {
  it('exportKif → shogiGameModel で指し手列が保存される', () => {
    const g = new ShogiPlayGame();
    for (const u of ['7g7f', '3c3d', '8h2b+', '3a2b']) {
      expect(g.applyUsi(u)).toBe(true);
    }
    const kif = g.exportKif({ black: 'You', white: 'AI' });
    const model = shogiGameModel(kif);
    expect(model.kind).toBe('shogi');
    expect(model.moves.map((m) => m.engineMove)).toEqual(['7g7f', '3c3d', '8h2b+', '3a2b']);
  });
});

describe('ShogiPlayGame snapshot', () => {
  it('描画に必要な読み取り値を不変オブジェクトへ集約する', () => {
    const g = new ShogiPlayGame();
    g.move('7g', '7f');
    const s = g.snapshot();
    expect(s.turn).toBe('gote');
    expect(s.moveCount).toBe(1);
    expect(s.lastMoveUsi).toBe('7g7f');
    expect(s.sfen).toBe(g.sfen);
    expect(s.outcome.over).toBe(false);
    expect(s.history).toHaveLength(1);
    // 後手番の合法手 dests が入っている（例: ８四歩）
    expect(s.legalDests.get('8c')).toContain('8d');
  });
});
