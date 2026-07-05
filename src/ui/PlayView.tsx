import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PlayGame,
  opposite,
  type PieceColor,
  type PlaySnapshot,
  type PromotionPiece,
} from '../core/playGame';
import { materialFromFen, lostPieces, type PieceLetter } from '../core/material';
import { createEngine, type EngineKind } from '../engine/factory';
import type { ChessEngine } from '../engine/types';
import {
  loadPlayedGames,
  savePlayedGame,
  deletePlayedGame,
  type PlayedGame,
} from '../core/storage';
import { PlayBoard } from './PlayBoard';

/*
 * PlayView — AI 戦(対局)画面
 *
 * Phase A の狙い(pivot「対局が先」):
 *   サーバー/アカウント無しで「指す → 勝敗 → 振り返る」のコアループを完成させる。
 *   対人戦・レート(Elo)は Phase C。ここでは AI(ローカル Stockfish)との対局と、
 *   指した対局の localStorage 履歴だけを扱う。
 *
 * 画面の状態機械:
 *   game(=gameRef) が null      → 設定画面(色・難度を選ぶ + 履歴一覧)
 *   game あり & 続行中          → 対局中(操作可能な盤 + 投了/待った)
 *   game あり & outcome.over    → 終局(結果 + 振り返る/もう一度/新規)
 *
 * 非同期オーケストレーションの肝(AI の手番):
 *   AI の思考(engine.chooseMove)は非同期。その最中にユーザーが「新しい対局」「待った」「投了」を
 *   押すと、古い AI 応答が新しい盤面に着手してしまう競合が起きる。これを turnTokenRef(単調増加)で
 *   防ぐ: 手番が切り替わる/局面が変わる操作でトークンを進め、AI 応答適用前にトークン一致を確認する。
 *   ReviewView の analyzeToken と同じ「キャンセルトークン」方式。
 *
 * なぜ PlayGame を ref + snapshot で扱うか:
 *   PlayGame は可変オブジェクトで useState では内部変異を検知できない。gameRef に実体を置き、
 *   描画に必要な値は snapshot(不変) を state に持って差し替える(playGame.ts の設計方針に一致)。
 */

/** 難易度。Stockfish の Skill Level(弱さ) + movetime(思考時間) にマップする。 */
interface Difficulty {
  key: string;
  label: string;
  /** Stockfish Skill Level 0-20。低いほど弱い(初心者が勝てる相手)。 */
  skill: number;
  /** 1手の思考時間(ms)。 */
  movetimeMs: number;
  /** 目安の説明。 */
  desc: string;
}

/*
 * 難易度の値の根拠(WHY この数字か):
 *   Skill Level はStockfishがわざとノイズをのせるレバーでEloに概ね対応する
 *   (skill 0≈1350, 5≈1500, 10≈1700, 15≈1950, 20≈full)。初心者が「やさしい」で勝てて、
 *   「最強」で歯が立たない体験を作るためこの4段に離散化した。movetime は lite-single(単スレッド)
 *   の体感速度を一定に保つための上限。長すぎると待たされ、短すぎると弱くなりすぎるので中庸に。
 *   Phase C で内部 Elo を入れる際、この skill→Elo 対応が初期レートの足場になる。
 */
const DIFFICULTIES: Difficulty[] = [
  { key: 'easy', label: 'やさしい', skill: 1, movetimeMs: 300, desc: '入門〜初心者' },
  { key: 'normal', label: 'ふつう', skill: 6, movetimeMs: 600, desc: '初級〜中級' },
  { key: 'hard', label: 'つよい', skill: 12, movetimeMs: 1000, desc: '中級〜上級' },
  { key: 'max', label: '最強', skill: 20, movetimeMs: 1500, desc: 'エンジン全力' },
];

/** あなたが持つ色の選択肢(random はゲーム開始時に確定)。 */
type ColorChoice = 'white' | 'black' | 'random';

/** 終局理由の日本語ラベル。 */
const REASON_LABEL: Record<string, string> = {
  checkmate: 'チェックメイト',
  stalemate: 'ステイルメイト',
  insufficient: '駒不足による引き分け',
  threefold: '同一局面3回による引き分け',
  fiftyMove: '50手ルールによる引き分け',
  draw: '引き分け',
  resign: '投了',
};

/** ランダム選択を具体的な色に解決する。 */
function resolveColor(choice: ColorChoice): PieceColor {
  // 対局開始時の1回だけの分岐なので Math.random で十分(暗号強度は不要)。
  if (choice === 'random') return Math.random() < 0.5 ? 'white' : 'black';
  return choice;
}

/** 履歴保存用の一意ID。crypto.randomUUID があれば使い、無ければ時刻+乱数で代替。 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface PlayViewProps {
  /** 「この対局を振り返る」で PGN をレビュー画面へ引き渡すコールバック。 */
  onReview: (pgn: string) => void;
}

export function PlayView({ onReview }: PlayViewProps) {
  // ── エンジン ────────────────────────────────────────────────
  const engineRef = useRef<ChessEngine | null>(null);
  const [engineKind, setEngineKind] = useState<EngineKind | 'loading'>('loading');

  // ── 対局状態 ────────────────────────────────────────────────
  const gameRef = useRef<PlayGame | null>(null);
  const [snap, setSnap] = useState<PlaySnapshot | null>(null);

  // 設定(設定画面での選択)
  const [colorChoice, setColorChoice] = useState<ColorChoice>('white');
  const [difficulty, setDifficulty] = useState<Difficulty>(DIFFICULTIES[1]); // 既定 ふつう

  // 進行中の対局で確定した自分の色/難度(ref で最新値を非同期処理から参照)
  const [youColor, setYouColor] = useState<PieceColor>('white');
  const youColorRef = useRef<PieceColor>('white');
  youColorRef.current = youColor;
  const activeDifficultyRef = useRef<Difficulty>(difficulty);

  const [orientation, setOrientation] = useState<PieceColor>('white');
  const [aiThinking, setAiThinking] = useState(false);
  // AI の手番でエンジンが失敗した(timeout/worker 終了)ことを UI に伝えるフラグ。
  // これが無いと「AIの番」のまま無言で固まり、初見ユーザーがフリーズと区別できない(reviewer 指摘)。
  const [aiError, setAiError] = useState(false);

  // AI 手番のキャンセルトークン(新規対局/待った/投了/アンマウントで進める)
  const turnTokenRef = useRef(0);
  // 現局面の終局を履歴に保存済みか(二重保存防止。待った/新規でリセット)
  const savedCurrentRef = useRef(false);

  // ── 履歴 ────────────────────────────────────────────────────
  const [history, setHistory] = useState<PlayedGame[]>([]);

  // ── エンジン初期化(ReviewView と同じ作法。別インスタンス=別 worker で競合回避) ──
  useEffect(() => {
    let disposed = false;
    // ref をローカルにエイリアスして cleanup 内で使う(react-hooks の
    // 「cleanup 実行時に ref.current が変化している可能性」警告を避ける定石。ReviewView と同じ手法)。
    const tokenRef = turnTokenRef;
    createEngine().then(({ engine, kind }) => {
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      setEngineKind(kind);
    });
    return () => {
      disposed = true;
      // アンマウント時は進行中の AI 応答を無効化してからエンジンを解放
      ++tokenRef.current;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // ── 履歴の初期ロード ────────────────────────────────────────
  useEffect(() => {
    setHistory(loadPlayedGames());
  }, []);

  // ── AI に1手指させる ────────────────────────────────────────
  /*
   * 呼ばれる条件: 「AI の手番」かつ「続行中」。トークンで多重・stale 適用を防ぐ。
   * WHY useCallback + ref 参照か: setTimeout/await をまたいでも最新の色・難度・トークンを
   * 見る必要があるため、可変なものは全て ref 経由で読む。
   */
  const runAiMove = useCallback(async () => {
    const game = gameRef.current;
    const engine = engineRef.current;
    if (!game || !engine) return;
    if (game.outcome().over) return;
    if (game.turn === youColorRef.current) return; // 自分の手番なら AI は動かない

    const myToken = turnTokenRef.current;
    setAiThinking(true);
    setAiError(false);
    try {
      const diff = activeDifficultyRef.current;
      const uci = await engine.chooseMove(game.fen, {
        skill: diff.skill,
        movetimeMs: diff.movetimeMs,
      });
      // await の間にキャンセルされていたら破棄(新規対局/待った/投了/アンマウント)
      if (myToken !== turnTokenRef.current) return;
      if (!uci) return; // 合法手なし(=詰み/ステイルメイト)。outcome が終局を表す
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promo = uci.length > 4 ? (uci[4] as PromotionPiece) : undefined;
      game.move(from, to, promo);
      setSnap(game.snapshot());
    } catch {
      // エンジンエラー(worker 終了/timeout 等)。無言で固まらないようフラグを立て、UI で
      // 「再試行」を出す(投了/新規でも復帰可能)。古いトークンなら無視(既にキャンセル済み)。
      if (myToken === turnTokenRef.current) setAiError(true);
    } finally {
      if (myToken === turnTokenRef.current) setAiThinking(false);
    }
  }, []);

  // ── ユーザーの着手 ──────────────────────────────────────────
  const handleUserMove = useCallback(
    (from: string, to: string, promotion?: PromotionPiece) => {
      const game = gameRef.current;
      if (!game) return;
      // AI 思考中は盤をロックしているが、保険で弾く
      if (aiThinking) return;
      // 終局後は着手しない(成りピッカー表示中に投了→駒選択の順で来る経路の防御。
      // core の PlayGame.move も終局を弾くが、UI 段でも早期に止めて二重に守る)。
      if (game.outcome().over) return;
      if (game.turn !== youColorRef.current) return;

      const mv = game.move(from, to, promotion);
      // 非合法(通常 chessground が弾くので来ない)は盤を現局面へ再同期して終わり
      setSnap(game.snapshot());
      if (!mv) return;

      // 自分が指したら AI の手番。続行中なら AI を起動。
      if (!game.outcome().over) {
        void runAiMove();
      }
    },
    [aiThinking, runAiMove],
  );

  // ── 対局開始 ────────────────────────────────────────────────
  const startGame = useCallback(
    (choice: ColorChoice, diff: Difficulty) => {
      const color = resolveColor(choice);
      const game = new PlayGame();

      // 同期的に ref を確定(runAiMove が即参照できるように state 更新前に入れる)
      gameRef.current = game;
      youColorRef.current = color;
      activeDifficultyRef.current = diff;
      ++turnTokenRef.current; // 前局の AI 応答を無効化
      savedCurrentRef.current = false;

      setYouColor(color);
      setOrientation(color);
      setAiThinking(false);
      setAiError(false);
      setSnap(game.snapshot());

      // 自分が黒 = AI(白)が先手 → 開始と同時に AI の初手
      if (color === 'black') void runAiMove();
    },
    [runAiMove],
  );

  // ── 投了 ────────────────────────────────────────────────────
  const handleResign = useCallback(() => {
    const game = gameRef.current;
    if (!game || game.outcome().over) return;
    ++turnTokenRef.current; // 進行中の AI 応答があれば無効化
    setAiThinking(false);
    game.resign(youColorRef.current);
    setSnap(game.snapshot());
  }, []);

  // ── 待った(1ラウンド戻す) ──────────────────────────────────
  // 仕様: 待ったは「対局中」専用(このボタンは !isOver のときだけレンダーされる)。
  // clearResign() は防御(万一終局状態から呼ばれても巻き戻せるように)だが、通常経路では
  // 対局中=resignedBy が null なので no-op。将来 ResultBanner に待ったを出す場合の布石でもある。
  const handleTakeback = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    ++turnTokenRef.current; // 進行中の AI 応答を無効化
    game.clearResign(); // 防御: 終局状態からでも巻き戻せるように(通常は no-op)
    if (!game.undo()) return; // 戻す手が無ければ何もしない
    // 戻した結果が AI の手番なら、自分の手番になるようもう1手戻す
    if (game.turn !== youColorRef.current) game.undo();
    savedCurrentRef.current = false; // 終局保存フラグを解除(巻き戻したので)
    setAiThinking(false);
    setAiError(false);
    setSnap(game.snapshot());
    // 戻した後が AI の手番なら(例: 黒番で AI 初手のみだった場合) AI に指させ直す
    if (!game.outcome().over && game.turn !== youColorRef.current) void runAiMove();
  }, [runAiMove]);

  // ── 設定へ戻る(対局を破棄) ──────────────────────────────────
  const handleNewGame = useCallback(() => {
    ++turnTokenRef.current;
    gameRef.current = null;
    savedCurrentRef.current = false;
    setAiThinking(false);
    setAiError(false);
    setSnap(null);
    // 履歴を最新化(直前対局が保存されている可能性)
    setHistory(loadPlayedGames());
  }, []);

  // ── 終局時に履歴へ自動保存 ──────────────────────────────────
  useEffect(() => {
    if (!snap || !snap.outcome.over) return;
    if (savedCurrentRef.current) return;
    const game = gameRef.current;
    if (!game) return;
    savedCurrentRef.current = true;

    const outcome = snap.outcome;
    const humanOutcome: PlayedGame['outcome'] =
      outcome.winner === null ? 'draw' : outcome.winner === youColor ? 'win' : 'loss';
    const opponent = `AI (${activeDifficultyRef.current.label})`;
    const pgn = game.pgn({
      Event: 'AI 戦',
      White: youColor === 'white' ? 'You' : opponent,
      Black: youColor === 'black' ? 'You' : opponent,
    });
    const played: PlayedGame = {
      id: newId(),
      createdAt: Date.now(),
      pgn,
      result: game.resultToken(),
      outcome: humanOutcome,
      youColor,
      opponent,
      moveCount: snap.moveCount,
    };
    setHistory(savePlayedGame(played));
  }, [snap, youColor]);

  // ── 派生値 ──────────────────────────────────────────────────
  const isOver = snap?.outcome.over ?? false;
  const inGame = snap !== null;

  /*
   * マテリアル(駒得)表示用の派生値。
   * WHY 毎レンダー再計算か: materialFromFen は FEN の文字数えだけで極めて軽く、
   * メモ化(useMemo)の管理コストの方が高い。snap.fen が変わる=レンダーのタイミングと一致する。
   * 「差」を見せるのが本質(ユーザー要望: 総得点でなく自分と相手の差)。
   */
  const material = snap ? materialFromFen(snap.fen) : null;
  const youMat = material ? (youColor === 'white' ? material.white : material.black) : null;
  const oppMat = material ? (youColor === 'white' ? material.black : material.white) : null;
  const oppColor = opposite(youColor);
  // AI 名は activeDifficultyRef から読む(startGame で snap 更新前に確定しているため描画時は常に最新)
  const opponentName = `AI (${activeDifficultyRef.current.label})`;

  // 盤を操作できるのは「自分の手番・思考中でない・続行中」のときだけ
  const movableColor: PieceColor | undefined =
    snap && !isOver && !aiThinking && snap.turn === youColor ? youColor : undefined;

  const engineLabel =
    engineKind === 'loading'
      ? '読み込み中…'
      : engineKind === 'stockfish'
        ? 'Stockfish WASM'
        : 'モック評価';

  // needsPromotion は gameRef の PlayGame に委譲(合法手ベースの判定)
  const isPromotion = useCallback((from: string, to: string) => {
    return gameRef.current?.needsPromotion(from, to) ?? false;
  }, []);

  // ── 描画 ────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      {/* エンジン状態(常時表示。設定/対局どちらでも見える) */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle">対局相手エンジン: {engineLabel}</span>
      </div>

      {!inGame ? (
        // ═══ 設定画面 ═══
        <SetupScreen
          colorChoice={colorChoice}
          difficulty={difficulty}
          engineLoading={engineKind === 'loading'}
          onColorChange={setColorChoice}
          onDifficultyChange={setDifficulty}
          onStart={() => startGame(colorChoice, difficulty)}
          history={history}
          onReviewHistory={(pgn) => onReview(pgn)}
          onDeleteHistory={(id) => setHistory(deletePlayedGame(id))}
        />
      ) : (
        // ═══ 対局画面 ═══
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* 盤 + プレイヤープレート(上=相手 / 下=あなた)
              プレートには lichess 流の「取った駒の列 + マテリアル点差(+N)」を表示。
              点差はリードしている側にだけ +N を出す(0 や負は出さない=差だけが意味を持つ)。 */}
          <section className="flex flex-col gap-4">
            <div className="mx-auto w-full max-w-[500px]">
              {youMat && oppMat && (
                <PlayerPlate
                  name={opponentName}
                  captured={lostPieces(youMat.counts)} // 相手が取った駒 = あなたが失った駒
                  capturedColor={youColor} // あなたの駒なのであなたの色のグリフ
                  diff={oppMat.points - youMat.points}
                  active={!isOver && snap.turn !== youColor}
                />
              )}
              <PlayBoard
                fen={snap.fen}
                orientation={orientation}
                turnColor={snap.turn}
                inCheck={snap.inCheck}
                lastMoveUci={snap.lastMoveUci}
                dests={snap.dests}
                movableColor={movableColor}
                isPromotion={isPromotion}
                onUserMove={handleUserMove}
              />
              {youMat && oppMat && (
                <PlayerPlate
                  name="あなた"
                  captured={lostPieces(oppMat.counts)} // あなたが取った駒 = 相手が失った駒
                  capturedColor={oppColor}
                  diff={youMat.points - oppMat.points}
                  active={!isOver && snap.turn === youColor}
                />
              )}
            </div>

            {/* 手番/状態インジケータ */}
            <div className="mx-auto flex w-full max-w-[500px] items-center justify-between gap-2">
              <TurnIndicator
                isOver={isOver}
                aiThinking={aiThinking}
                yourTurn={snap.turn === youColor}
                youColor={youColor}
              />
              <button
                type="button"
                onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
                aria-label={`盤を反転（現在: ${orientation === 'white' ? '白目線' : '黒目線'}）`}
                title="盤を反転"
                className="focus-ai min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface-2"
              >
                ⇅
              </button>
            </div>

            {/* AI 応答失敗の通知(無言フリーズ回避)。再試行で同じ局面をもう一度考えさせる。 */}
            {aiError && !isOver && (
              <div
                role="alert"
                className="mx-auto flex w-full max-w-[500px] items-center justify-between gap-2 rounded-lg border border-[var(--q-miss-fg)] bg-[var(--q-miss-bg)] px-3 py-2 text-xs text-[var(--q-miss-fg)]"
              >
                <span>AI の応答に失敗しました。もう一度試すか、投了/新規で続けられます。</span>
                <button
                  type="button"
                  onClick={() => void runAiMove()}
                  disabled={aiThinking}
                  className="focus-ai min-h-9 shrink-0 rounded border border-[var(--q-miss-fg)] px-2 py-1 font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                >
                  再試行
                </button>
              </div>
            )}
          </section>

          {/* サイド: 結果/操作/棋譜 */}
          <aside className="flex flex-col gap-4">
            {/* 終局バナー */}
            {isOver && snap.outcome.over && (
              <ResultBanner
                outcome={snap.outcome}
                youColor={youColor}
                onReview={() => {
                  const game = gameRef.current;
                  if (game) onReview(game.pgn());
                }}
                onRematch={() => startGame(colorChoice, difficulty)}
                onNewGame={handleNewGame}
              />
            )}

            {/* 対局中の操作 */}
            {!isOver && (
              <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-surface-2 p-3">
                <button
                  type="button"
                  onClick={handleTakeback}
                  disabled={snap.history.length === 0 || aiThinking}
                  className="focus-ai min-h-11 flex-1 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
                >
                  待った
                </button>
                <button
                  type="button"
                  onClick={handleResign}
                  className="focus-ai min-h-11 flex-1 rounded-lg border border-[var(--q-miss-fg)] px-3 text-sm font-medium text-[var(--q-miss-fg)] transition-colors hover:bg-[var(--q-miss-bg)]"
                >
                  投了
                </button>
                <button
                  type="button"
                  onClick={handleNewGame}
                  className="focus-ai min-h-11 flex-1 rounded-lg border border-border px-3 text-sm text-muted transition-colors hover:bg-surface hover:text-on-surface"
                >
                  中断して新規
                </button>
              </div>
            )}

            {/* 棋譜(この対局の手順) */}
            <PlayMoveList moves={snap.history} />
          </aside>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * 以下、PlayView 内でのみ使う小コンポーネント群。
 * ファイル分割しないのは、いずれも PlayView の状態と密結合の表示専用で、
 * 単体再利用の予定が無いため(コヒーレンス優先)。
 * ════════════════════════════════════════════════════════════ */

/** 設定画面: 色・難度の選択 + 履歴一覧。 */
function SetupScreen({
  colorChoice,
  difficulty,
  engineLoading,
  onColorChange,
  onDifficultyChange,
  onStart,
  history,
  onReviewHistory,
  onDeleteHistory,
}: {
  colorChoice: ColorChoice;
  difficulty: Difficulty;
  engineLoading: boolean;
  onColorChange: (c: ColorChoice) => void;
  onDifficultyChange: (d: Difficulty) => void;
  onStart: () => void;
  history: PlayedGame[];
  onReviewHistory: (pgn: string) => void;
  onDeleteHistory: (id: string) => void;
}) {
  const COLOR_OPTIONS: { value: ColorChoice; label: string }[] = [
    { value: 'white', label: '白（先手）' },
    { value: 'black', label: '黒（後手）' },
    { value: 'random', label: 'ランダム' },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* 設定パネル */}
      <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface-2 p-5">
        <div>
          <h2 className="text-base font-semibold text-on-surface">AI と対局</h2>
          <p className="mt-1 text-xs text-muted">
            ローカルの Stockfish と対局します。指した対局はこの端末に履歴として保存され、
            あとから1手ずつ振り返れます。
          </p>
        </div>

        {/* 手番の色 */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted">あなたの手番</p>
          <div className="flex flex-wrap gap-2">
            {COLOR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onColorChange(opt.value)}
                aria-pressed={colorChoice === opt.value}
                className={[
                  'focus-ai min-h-11 rounded-lg border px-4 text-sm font-medium transition-colors',
                  colorChoice === opt.value
                    ? 'border-ai bg-ai text-white dark:bg-ai-dim'
                    : 'border-border text-muted hover:border-ai hover:text-ai',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 難易度 */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted">強さ</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => onDifficultyChange(d)}
                aria-pressed={difficulty.key === d.key}
                className={[
                  'focus-ai flex min-h-16 flex-col items-center justify-center rounded-lg border px-2 py-2 text-center transition-colors',
                  difficulty.key === d.key
                    ? 'border-ai bg-ai-bg text-ai dark:bg-ai-deep dark:text-ai-muted'
                    : 'border-border text-muted hover:border-ai',
                ].join(' ')}
              >
                <span className="text-sm font-semibold">{d.label}</span>
                <span className="mt-0.5 text-[10px] opacity-80">{d.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={onStart}
          disabled={engineLoading}
          className="focus-ai min-h-12 rounded-xl bg-ai px-6 text-base font-semibold text-white transition-colors hover:bg-ai-hover disabled:cursor-not-allowed disabled:opacity-50 dark:bg-ai-dim dark:hover:bg-ai"
        >
          {engineLoading ? 'エンジン読み込み中…' : '対局開始'}
        </button>
      </section>

      {/* 履歴一覧 */}
      <aside>
        <GameHistory
          history={history}
          onReview={onReviewHistory}
          onDelete={onDeleteHistory}
        />
      </aside>
    </div>
  );
}

/** 取った駒のグリフ(色別)。相手から取った駒はその駒の色で見せる。 */
const CAPTURED_GLYPHS: Record<PieceColor, Record<PieceLetter, string>> = {
  white: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' },
  black: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' },
};

/**
 * プレイヤープレート — 名前 + 取った駒の列 + マテリアル点差。
 *
 * 表示ルール(lichess/chess.com 慣行に合わせる):
 *   - 取った駒は価値の低い順(p→n→b→r→q)に並べる(視線が自然に流れる)
 *   - 点差 +N はリードしている側にだけ表示(0/劣勢は非表示 — “差”だけが情報)
 *   - active(手番側)は名前を強調して「どちらが考える番か」を示す
 */
function PlayerPlate({
  name,
  captured,
  capturedColor,
  diff,
  active,
}: {
  name: string;
  /** この側が取った駒の数(相手の失った駒)。 */
  captured: Record<PieceLetter, number>;
  /** 取った駒のグリフ色(=相手の色)。 */
  capturedColor: PieceColor;
  /** この側から見た点差。> 0 のときだけ +N を表示。 */
  diff: number;
  /** 手番側なら true(名前を強調)。 */
  active: boolean;
}) {
  const order: PieceLetter[] = ['p', 'n', 'b', 'r', 'q'];
  const glyphs = order
    .flatMap((k) => Array<string>(captured[k]).fill(CAPTURED_GLYPHS[capturedColor][k]))
    .join('');

  return (
    <div className="flex min-h-7 items-center gap-2 px-1 py-0.5">
      <span
        className={[
          'text-sm',
          active ? 'font-semibold text-on-surface' : 'text-muted',
        ].join(' ')}
      >
        {name}
      </span>
      {glyphs && (
        <span aria-label="取った駒" className="text-base leading-none text-muted">
          {glyphs}
        </span>
      )}
      {diff > 0 && (
        <span
          aria-label={`マテリアル ${diff} ポイントリード`}
          className="text-xs font-bold tabular-nums text-ai"
        >
          +{diff}
        </span>
      )}
    </div>
  );
}

/** 手番/状態のインジケータ。 */
function TurnIndicator({
  isOver,
  aiThinking,
  yourTurn,
  youColor,
}: {
  isOver: boolean;
  aiThinking: boolean;
  yourTurn: boolean;
  youColor: PieceColor;
}) {
  let text: string;
  if (isOver) text = '対局終了';
  else if (aiThinking) text = 'AI が考えています…';
  else if (yourTurn) text = 'あなたの番';
  else text = 'AI の番';

  return (
    <div className="flex items-center gap-2 text-sm text-on-surface">
      {/* あなたの色の小さな駒アイコン */}
      <span
        aria-hidden="true"
        className={[
          'inline-block h-3 w-3 rounded-full border',
          youColor === 'white' ? 'border-border bg-white' : 'border-border bg-black',
        ].join(' ')}
      />
      <span aria-live="polite">{text}</span>
    </div>
  );
}

/** 終局バナー(結果 + 振り返る/もう一度/新規)。 */
function ResultBanner({
  outcome,
  youColor,
  onReview,
  onRematch,
  onNewGame,
}: {
  outcome: Extract<PlaySnapshot['outcome'], { over: true }>;
  youColor: PieceColor;
  onReview: () => void;
  onRematch: () => void;
  onNewGame: () => void;
}) {
  const draw = outcome.winner === null;
  const youWon = outcome.winner === youColor;
  const title = draw ? '引き分け' : youWon ? 'あなたの勝ち！' : 'あなたの負け';
  const tone = draw
    ? 'border-border bg-surface'
    : youWon
      ? 'border-[var(--q-good-fg)] bg-[var(--q-good-bg)]'
      : 'border-[var(--q-miss-fg)] bg-[var(--q-miss-bg)]';

  return (
    // role="status" で終局と勝敗をスクリーンリーダーに読み上げる(TurnIndicator は「対局終了」しか伝えないため)。
    <div className={`rounded-xl border p-4 ${tone}`} role="status">
      <p className="text-lg font-bold text-on-surface">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{REASON_LABEL[outcome.reason] ?? '終局'}</p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={onReview}
          className="focus-ai min-h-11 rounded-lg bg-ai px-4 text-sm font-semibold text-white transition-colors hover:bg-ai-hover dark:bg-ai-dim dark:hover:bg-ai"
        >
          この対局を振り返る
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRematch}
            className="focus-ai min-h-11 flex-1 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface-2"
          >
            もう一度
          </button>
          <button
            type="button"
            onClick={onNewGame}
            className="focus-ai min-h-11 flex-1 rounded-lg border border-border px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-on-surface"
          >
            設定へ
          </button>
        </div>
      </div>
    </div>
  );
}

/** この対局の棋譜(手順)。ペア(白/黒)で並べる読み取り専用リスト。 */
function PlayMoveList({ moves }: { moves: PlaySnapshot['history'] }) {
  const endRef = useRef<HTMLDivElement>(null);
  // 手が増えたら最下部へスクロール(reduced-motion を尊重)。
  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [moves.length]);

  const rows: { no: number; white?: string; black?: string }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ no: i / 2 + 1, white: moves[i]?.san, black: moves[i + 1]?.san });
  }

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-3">
      <h3 className="mb-2 text-xs font-semibold text-muted">棋譜</h3>
      {moves.length === 0 ? (
        <p className="text-xs text-subtle">まだ手がありません</p>
      ) : (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {rows.map((r) => (
                <tr key={r.no} className="border-b border-border last:border-0">
                  <td className="w-8 py-0.5 pr-2 text-right text-xs text-subtle select-none">
                    {r.no}.
                  </td>
                  <td className="py-0.5 pr-2 font-mono">{r.white ?? ''}</td>
                  <td className="py-0.5 font-mono">{r.black ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

/** 過去対局の履歴一覧(振り返る/削除)。 */
function GameHistory({
  history,
  onReview,
  onDelete,
}: {
  history: PlayedGame[];
  onReview: (pgn: string) => void;
  onDelete: (id: string) => void;
}) {
  const OUTCOME_BADGE: Record<PlayedGame['outcome'], { label: string; cls: string }> = {
    win: { label: '勝ち', cls: 'text-[var(--q-good-fg)]' },
    loss: { label: '負け', cls: 'text-[var(--q-miss-fg)]' },
    draw: { label: '引分', cls: 'text-muted' },
    unfinished: { label: '中断', cls: 'text-subtle' },
  };

  return (
    <div className="rounded-2xl border border-border bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-on-surface">対局履歴</h2>
      {history.length === 0 ? (
        <p className="mt-2 text-xs text-subtle">
          まだ対局がありません。左で設定して「対局開始」を押してください。
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {history.map((g) => {
            const badge = OUTCOME_BADGE[g.outcome];
            return (
              <li
                key={g.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${badge.cls}`}>{badge.label}</span>
                    <span className="truncate text-xs text-muted">
                      {g.opponent}・{g.youColor === 'white' ? '白' : '黒'}・{g.moveCount}手
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onReview(g.pgn)}
                  className="focus-ai flex min-h-11 shrink-0 items-center rounded border border-border px-2.5 text-xs text-muted transition-colors hover:border-ai hover:text-ai"
                >
                  振り返る
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(g.id)}
                  aria-label="この対局を削除"
                  title="削除"
                  className="focus-ai flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded border border-border text-xs text-subtle transition-colors hover:border-[var(--q-miss-fg)] hover:text-[var(--q-miss-fg)]"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
