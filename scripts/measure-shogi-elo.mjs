/*
 * measure-shogi-elo.mjs — やねうら王(k-p) を Node ヘッドレスで自己対局させ、
 *   将棋 AI 対局の難度プリセット（SkillLevel × NodesLimit）の相対強度を実測するツール。
 *
 * WHY 存在するか:
 *   ShogiPlaySession の difficulty プリセット（elo 目安 = 強さ表示 + レート戦の相手レート）は
 *   当初チェス流用の暫定値だった。本ツールで自己対局の勝率から相対 Elo 差を測り、プリセットが
 *   ①順序どおり分離しているか ②表示 elo の gap が実測と整合するか を検証・再校正する。
 *   プリセット（skill/nodes/movetime）を変えたら再実行して回帰を確認する用途にも使える。
 *
 * 使い方:
 *   node scripts/measure-shogi-elo.mjs [games_per_pair=16]
 *   （やねうら王 k-p を Node で起動。crossOriginIsolated 不要＝Node の worker_threads+SAB で動く。
 *    eval は k-p ビルドに埋め込みなので外部ファイル不要。1 スレッド固定・定跡 off で計測。）
 *
 * 方式:
 *   - 1 エンジンインスタンスを共有し、手番側の cfg(skill/nodes)を setoption して go → bestmove。
 *   - 局面管理・合法性・終局(詰み/千日手/連続王手)は tsshogi に委ねる（アプリの shogiPlayGame と同権威）。
 *   - 先後を入れ替えて色バイアスを相殺。長手数(既定 320)超過は引き分け扱い（持将棋 adjudicate は簡略化）。
 *   - go は nodes 指定（決定的・高速）。max(nodes 無制限)は測定用に goNodes でキャップする
 *     （実アプリの movetime はさらに探索するので、実際の max は本測定より強い＝gap は下限）。
 *
 * 注意（結果の読み方）:
 *   - 0/16 のような飽和ペアの Elo 差は「下限」（勝率0%は真の差がそれ以上）。
 *   - 絶対 Elo は将棋では基準が曖昧（将棋ウォーズ/81dojo/floodgate で桁が違う）。本ツールが出すのは
 *     **相対** Elo 差。表示 elo の絶対値は UX 目安として別途決める（"~" 付き表記を維持）。
 *
 * ライセンス: やねうら王/評価関数は GPL-3.0。本スクリプトは Worker/postMessage 越しに利用するのみ（改変なし）。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// tsshogi は ESM。やねうら王 glue は CJS なので createRequire で読む。
const { Record, Position, Move, Color, Square } = await import('tsshogi');
const YaneuraOu = require('@mizarjp/yaneuraou.k-p/lib/yaneuraou.k-p.js');

/** 持ち駒として打てる駒ロール（玉・成駒は持ち駒にならない）。 */
const HAND_ROLES = new Set(['pawn', 'lance', 'knight', 'silver', 'gold', 'bishop', 'rook']);

/** 手番側に合法手（盤上/打ち）が 1 つでもあるか（詰み判定）。shogiPlayGame.hasAnyLegalMove と同ロジック。 */
function hasAnyLegalMove(pos) {
  const squares = pos.board
    .listNonEmptySquares()
    .filter((sq) => pos.board.at(sq)?.color === pos.color);
  for (const from of squares) {
    for (const to of Square.all) {
      const plain = pos.createMove(from, to);
      if (!plain) continue;
      if (pos.isValidMove(plain)) return true;
      if (pos.isValidMove(plain.withPromote())) return true;
    }
  }
  for (const { type, count } of pos.hand(pos.color).counts) {
    if (count <= 0 || !HAND_ROLES.has(type)) continue;
    for (const to of Square.all) {
      if (pos.board.at(to)) continue;
      const m = pos.createMove(type, to);
      if (m && pos.isValidMove(m)) return true;
    }
  }
  return false;
}

/** tsshogi Record の実手数を数える（先頭 START ノードを除く）。 */
function moveCount(rec) {
  let n = 0;
  for (const node of rec.moves) if (node.move instanceof Move) n++;
  return n;
}

/** やねうら王を Node で起動し、bestMove(sfen, cfg) を提供するハンドルを返す。 */
async function startEngine() {
  const y = await YaneuraOu();
  const lines = [];
  y.addMessageListener((l) => lines.push(l));
  const waitFor = (pred, ms = 40000) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('engine timeout')), ms);
      const iv = setInterval(() => {
        const idx = lines.findIndex(pred);
        if (idx >= 0) {
          clearInterval(iv);
          clearTimeout(timer);
          res(lines[idx]);
        }
      }, 5);
    });
  y.postMessage('usi');
  await waitFor((l) => l === 'usiok');
  y.postMessage('setoption name USI_OwnBook value false'); // 定跡 off（実力を測る）
  y.postMessage('setoption name Threads value 1'); // 安定・再現性のため 1 スレッド
  y.postMessage('setoption name USI_Hash value 64');
  y.postMessage('isready');
  await waitFor((l) => l === 'readyok');
  return {
    async bestMove(sfen, cfg) {
      y.postMessage(`setoption name SkillLevel value ${cfg.skill}`);
      y.postMessage(`setoption name NodesLimit value ${cfg.nodes}`);
      y.postMessage('setoption name MultiPV value 1');
      y.postMessage('usinewgame');
      y.postMessage(`position sfen ${sfen}`);
      lines.length = 0;
      y.postMessage(
        cfg.movetime ? `go movetime ${cfg.movetime}` : `go nodes ${cfg.goNodes ?? cfg.nodes}`,
      );
      const bm = await waitFor((l) => l.startsWith('bestmove'));
      return bm.split(' ')[1]; // '<usi>' | 'resign' | 'win' | 'none'
    },
    terminate: () => y.terminate(),
  };
}

/** 1 局対局。cfgBlack=先手, cfgWhite=後手。startSfen 省略で平手。winner: 'black'|'white'|null(引分)。 */
async function playGame(engine, cfgBlack, cfgWhite, maxPlies = 320, startSfen) {
  const startPos = startSfen ? Position.newBySFEN(startSfen) : null;
  const rec = startPos ? new Record(startPos) : new Record();
  for (;;) {
    const pos = rec.position;
    const loserIsToMove = () => (pos.color === Color.BLACK ? 'white' : 'black');
    if (!hasAnyLegalMove(pos)) return { winner: loserIsToMove(), reason: 'mate' };
    if (rec.repetition) {
      const pc = rec.perpetualCheck; // 王手継続側=負け
      if (pc) return { winner: pc === Color.BLACK ? 'white' : 'black', reason: 'perpetual' };
      return { winner: null, reason: 'repetition' };
    }
    if (moveCount(rec) >= maxPlies) return { winner: null, reason: 'maxPlies' };
    const cfg = pos.color === Color.BLACK ? cfgBlack : cfgWhite;
    const usi = await engine.bestMove(pos.sfen, cfg);
    if (!usi || usi === 'resign' || usi === 'win' || usi === 'none') {
      return { winner: loserIsToMove(), reason: 'resign' };
    }
    const move = pos.createMoveByUSI(usi);
    if (!move || !pos.isValidMove(move)) return { winner: loserIsToMove(), reason: 'illegal' };
    rec.append(move);
  }
}

/*
 * アプリ（ShogiPlaySession の DIFFICULTIES）と一致させるプリセット。
 *   nodes/goNodes = NodesLimit（探索量の弱さレバー）。movetime = アプリの movetimeMs。
 *
 * 計測モード（Codex ゲート② F001 対応）: 既定は go nodes（決定的・高速）。
 *   ・easy/normal/hard は 40k-280k ノード（≈40-280ms）で、アプリの movetime(400-1000ms)より
 *     NodesLimit が先に効く＝node 計測はアプリと忠実。
 *   ・max はアプリで NodesLimit=0・movetime 1500ms（時間律速）。node モードでは goNodes=500k に
 *     キャップするため過小測定になる。max を忠実に測るには MEASURE_MOVETIME=1（movetime モード）。
 *   env MEASURE_MOVETIME=1 で全プリセットを go movetime（アプリ完全再現・ただし max は遅い）で測る。
 */
const MOVETIME_MODE = process.env.MEASURE_MOVETIME === '1';
const PRESETS = {
  easy: { skill: 2, nodes: 40_000, goNodes: 40_000, movetimeMs: 400 },
  normal: { skill: 8, nodes: 160_000, goNodes: 160_000, movetimeMs: 700 },
  hard: { skill: 14, nodes: 280_000, goNodes: 280_000, movetimeMs: 1000 },
  max: { skill: 20, nodes: 0, goNodes: 500_000, movetimeMs: 1500 },
};
/** cfg を計測モードに合わせて整える（movetime モードなら movetime を使い goNodes を無視）。 */
function forMode(cfg) {
  return MOVETIME_MODE ? { ...cfg, movetime: cfg.movetimeMs, goNodes: undefined } : cfg;
}

/*
 * 開始局面のサンプル（Codex ゲート② F002 対応）。全局 hirate だと「初期局面からの特定展開」に
 * 偏るため、代表的な開始局面を巡回サンプリングして局面種別の偏りを緩和する。
 * 追加局面は「合法・両玉あり・序中盤」を選ぶ（tsshogi が Position.newBySFEN で受理する SFEN）。
 * SFEN 空配列 or 未指定なら hirate のみ（従来互換）。必要なら定跡開始局面を足す。
 */
const OPENINGS = [
  'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', // 平手
  'lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 1', // 相掛かり系の入り
  'lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 1', // 角道保留・両端歩
];

/** N 局・先後入替＋開始局面巡回でペア対戦し、A の勝敗を集計。 */
async function match(engine, nameA, nameB, games) {
  const A = forMode(PRESETS[nameA]);
  const B = forMode(PRESETS[nameB]);
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  for (let i = 0; i < games; i++) {
    const aIsBlack = i % 2 === 0; // 色相殺
    const startSfen = OPENINGS[i % OPENINGS.length]; // 開始局面を巡回（局面偏り緩和）
    const r = await playGame(engine, aIsBlack ? A : B, aIsBlack ? B : A, 320, startSfen);
    if (r.winner === null) draws++;
    else if ((r.winner === 'black') === aIsBlack) aWins++;
    else bWins++;
    process.stdout.write(
      `\r  ${nameA} vs ${nameB}: ${i + 1}/${games} (A${aWins} B${bWins} D${draws})   `,
    );
  }
  process.stdout.write('\n');
  return { aWins, bWins, draws };
}

/** 得点率 → Elo 差（±800 で飽和クランプ＝0/100% は下限/上限）。 */
function eloDiff(score) {
  if (score <= 0) return -800;
  if (score >= 1) return 800;
  return Math.round(-400 * Math.log10(1 / score - 1));
}

// ── 実行 ──
const games = Number(process.argv[2] ?? 16);
const engine = await startEngine();
console.log(`self-play 開始 (games/pair=${games})`);
const pairings = [
  ['easy', 'normal'],
  ['normal', 'hard'],
  ['hard', 'max'],
  ['easy', 'hard'],
];
const results = {};
for (const [a, b] of pairings) {
  const t = Date.now();
  const { aWins, bWins, draws } = await match(engine, a, b, games);
  const total = aWins + bWins + draws;
  const scoreA = (aWins + draws * 0.5) / total;
  results[`${a}_vs_${b}`] = {
    aWins,
    bWins,
    draws,
    scoreA: +scoreA.toFixed(3),
    eloDiff_AminusB: eloDiff(scoreA),
    sec: Math.round((Date.now() - t) / 1000),
  };
  console.log(
    `  → ${a} 得点率 ${(scoreA * 100).toFixed(0)}% / Elo差(${a}-${b}) ${eloDiff(scoreA)}`,
  );
}
engine.terminate();
console.log('\n=== RESULT JSON ===');
console.log(JSON.stringify(results, null, 2));
process.exit(0);
