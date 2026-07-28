import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  PlayGame,
  opposite,
  type PieceColor,
  type PlaySnapshot,
  type PromotionPiece,
} from '../core/playGame';
import { materialFromFen, lostPieces, type PieceLetter } from '../core/material';
import { applyResult, INITIAL_RATING, type GameScore } from '../core/rating';
import { createEngine, type EngineKind } from '../engine/factory';
import type { ChessEngine } from '../engine/types';
import type { GameKind } from '../core/types';
import {
  loadPlayedGames,
  savePlayedGame,
  deletePlayedGame,
  loadRating,
  saveRating,
  playedGameKind,
  type PlayedGame,
  type RatingData,
} from '../core/storage';
import { useAuth } from '../auth/authState';
import { syncAiGameToCloud } from '../auth/cloudSync';
import { notifyCloudSyncFailureOnce } from '../auth/cloudSyncNotify';
import { PlayBoard } from './PlayBoard';

/*
 * ShogiPlaySession は将棋タブを開いたときだけ読み込む（React.lazy で code-split）。
 * WHY（1バイト不変条件）: 将棋一式(tsshogi/shogiground/やねうら王) をチェス利用者のメインチャンクに
 *   1 バイトも載せない。ここを static import にすると shogiground 等がメインへ漏れるので必ず動的 import。
 *   ReviewView が ShogiBoard を lazy 化しているのと同じ規律。ShogiPlaySession は default export。
 */
const ShogiPlaySession = lazy(() => import('./ShogiPlaySession'));

/** 対局履歴からチェスの対局だけを取り出す（将棋は ShogiPlaySession 側で表示・Codex 修正 #3）。 */
function loadChessHistory(): PlayedGame[] {
  return loadPlayedGames().filter((g) => playedGameKind(g) === 'chess');
}

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
  /**
   * 目安 Elo(オーナー要望 2026-07-07: AI の強さを数値で見せる)。
   * レート戦(ローカル内部レート)の相手レートとしても使う=Elo 計算の入力。
   */
  elo: number;
}

/*
 * 難易度の値の根拠(WHY この数字か):
 *   Skill Level はStockfishがわざとノイズをのせるレバーでEloに概ね対応する
 *   (公称は skill0≈1350〜skill20≈3190 だが、これは十分な思考時間での値)。
 *   本アプリは lite-single(単スレッド) + 短い movetime なので体感はそれより弱い。
 *   elo はその体感に合わせた“目安”(lichess/chess.com のボット感覚に寄せた保守的な値):
 *     やさしい skill1/300ms  ≈ 800  (入門者が勝てる)
 *     ふつう   skill6/600ms  ≈ 1400 (初中級の壁)
 *     つよい   skill12/1000ms ≈ 1900 (上級の入り口)
 *     最強     skill20/1500ms ≈ 2800 (人間はほぼ勝てない)
 *   この elo はレート戦の Elo 計算の相手レートにも使う。数値を変えるとユーザーの
 *   レート変動カーブが変わるので、変更時は rating.ts のテストと合わせて検討すること。
 */
const DIFFICULTIES: Difficulty[] = [
  { key: 'easy', label: 'やさしい', skill: 1, movetimeMs: 300, desc: '入門〜初心者', elo: 800 },
  { key: 'normal', label: 'ふつう', skill: 6, movetimeMs: 600, desc: '初級〜中級', elo: 1400 },
  { key: 'hard', label: 'つよい', skill: 12, movetimeMs: 1000, desc: '中級〜上級', elo: 1900 },
  { key: 'max', label: '最強', skill: 20, movetimeMs: 1500, desc: 'エンジン全力', elo: 2800 },
];

/*
 * 難易度カードの装飾グリフ。
 * チェス駒の強さで難度を直感的に表現する(ポーン→ナイト→ルーク→クイーン)。
 * WHY Unicode チェス記号か: 外部フォント不要、単色のため多色制限に抵触しない、
 * COEP 制約にも影響しない。aria-hidden で SR への余分な読み上げをなくす。
 */
const DIFFICULTY_ICONS: Record<string, string> = {
  easy: '♙', // ポーン   — 最も弱い駒 → 入門
  normal: '♘', // ナイト  — 個性的な動き → 初〜中級
  hard: '♖', // ルーク  — 直線制圧力 → 中〜上級
  max: '♛', // クイーン — 最強の駒  → エンジン全力
};

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
  /**
   * 「この対局を振り返る」でレビュー画面へ引き渡すコールバック（kind 対応・Codex 修正 #2）。
   * chess は PGN、shogi は KIF を text に載せ、kind でレビュー側の分岐を決める。
   */
  onReview: (record: { kind: GameKind; text: string }) => void;
  /**
   * レビュー画面からの「この局面から対局」(Phase 2B: チェス / Phase 4-3: 将棋)。
   * nonce を変えて渡すたびに、その局面からカジュアル対局(レート変動なし)を開始する。
   * WHY nonce か: 同じ局面を連続で渡しても再開始できるように、値の変化で発火を検知する。
   * kind: チェスなら fen は FEN で下の chess startGame へ、将棋なら fen は SFEN で ShogiPlaySession へ。
   *   WHY フィールド名を fen のまま将棋 SFEN も載せるか: storage.ts が KIF を pgn フィールドに載せて
   *   「フィールド名の負債を許容」した前例に倣い、本番稼働中のチェス経路の diff を最小化して回帰を避ける
   *   （この playFrom はメモリ上の一時 state で永続化されないためリネームも安全だが、チェス経路無改修を優先）。
   */
  playFrom?: { fen: string; nonce: number; kind: GameKind } | null;
}

export function PlayView({ onReview, playFrom }: PlayViewProps) {
  // ── ゲーム種別（チェス/将棋 切替・Codex 修正 #1: 共通シェル + kind 別セッション） ──
  // 既定 chess（チェス利用者の体験を一切変えない）。将棋は初回選択時に mount し、以降 hidden で保持
  // （App の reviewMounted と同型。切替で進行中の対局を失わない）。
  const [kind, setKind] = useState<GameKind>('chess');
  const [shogiMounted, setShogiMounted] = useState(false);
  const switchKind = useCallback((k: GameKind) => {
    if (k === 'shogi') setShogiMounted(true);
    setKind(k);
  }, []);

  // クラウド自己履歴用（auth 無効時は status=disabled → sync は no-op）
  const { status: authStatus } = useAuth();

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

  // ── ローカル内部レート(2026-07-07 オーナー GO) ────────────────
  /*
   * 設計: レート戦(rated) の AI 戦だけレートが動く。カジュアル戦は変動なし(オーナー構想)。
   * 相手レート = 難易度の目安 Elo。Phase 2C でクラウド(profiles.rating)へ昇格予定のローカル実装。
   *
   * レート変動なしになる条件(公平性のための仕様):
   *   - カジュアル選択時
   *   - 「待った」を1回でも使った対局(usedTakebackRef)
   *   - レビュー局面からの対局(Phase 2B: 任意局面スタートは有利不利が不明なため常にカジュアル)
   */
  const [myRating, setMyRating] = useState<RatingData>(
    () =>
      loadRating() ?? {
        rating: INITIAL_RATING,
        games: 0,
      },
  );
  // 設定画面の選択(既定=レート戦。オーナー構想「カジュアルはレートが変動しない」の対になる既定)
  const [ratedChoice, setRatedChoice] = useState(true);
  // 進行中の対局がレート戦か(開始時に確定。ref で非同期処理からも読める)
  const activeRatedRef = useRef(false);
  // この対局で「待った」を使ったか → 使ったらレート変動なしに降格
  const usedTakebackRef = useRef(false);
  // 終局時のレート変動結果(ResultBanner 表示用)。null = カジュアル or 未終局。
  const [ratingResult, setRatingResult] = useState<{
    before: number;
    after: number;
    delta: number;
  } | null>(null);

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

  // ── 履歴の初期ロード（チェスのみ表示） ──────────────────────
  useEffect(() => {
    setHistory(loadChessHistory());
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
  /*
   * opts.startFen: Phase 2B「この局面から対局」。指定時は色選択を無視して
   *   「その局面の手番側」をあなたに割り当てる(振り返り中の局面を"自分が指す番"として再開する意図)。
   * opts.rated: レート戦か。startFen 指定時は強制カジュアル(任意局面は有利不利が不明で
   *   レートの公平性が保てないため)。
   */
  const startGame = useCallback(
    (choice: ColorChoice, diff: Difficulty, opts?: { startFen?: string; rated?: boolean }) => {
      const startFen = opts?.startFen;
      let game: PlayGame;
      try {
        game = new PlayGame(startFen);
      } catch {
        // 不正 FEN(手入力ミス等)。開始せず設定画面に留まる(呼び出し側でバリデーション済みが基本)。
        return;
      }
      // startFen 指定時 = その局面の手番側があなた。通常時 = 選択(ランダム解決)。
      const color: PieceColor = startFen ? game.turn : resolveColor(choice);

      // 同期的に ref を確定(runAiMove が即参照できるように state 更新前に入れる)
      gameRef.current = game;
      youColorRef.current = color;
      activeDifficultyRef.current = diff;
      // レート戦判定: startFen 対局は強制カジュアル。待ったフラグもリセット。
      activeRatedRef.current = Boolean(opts?.rated) && !startFen;
      usedTakebackRef.current = false;
      ++turnTokenRef.current; // 前局の AI 応答を無効化
      savedCurrentRef.current = false;

      setYouColor(color);
      setOrientation(color);
      setAiThinking(false);
      setAiError(false);
      setRatingResult(null);
      setSnap(game.snapshot());

      // AI が先手(あなたが後手番)なら開始と同時に AI の初手
      if (game.turn !== color) void runAiMove();
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
    // 待ったを使った対局はレート変動なしに降格(公平性)。UI にも注記が出る。
    usedTakebackRef.current = true;
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
    // 履歴を最新化(直前対局が保存されている可能性。チェスのみ表示)
    setHistory(loadChessHistory());
  }, []);

  // ── 終局時に履歴へ自動保存 + レート更新 ─────────────────────
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
    // 0手対局(開始直後の投了)は履歴に保存しない。
    // WHY: 手の無い PGN は ReviewView(ChessGame.fromPgn)が「手が見つかりません」で読めず、
    // 履歴の「振り返る」が必ずエラーになる(実E2Eで発覚)。見る中身も無いので保存自体を省く。
    // レート戦の場合のレート減算は下で通常どおり行う(即投了の逃げ得防止)。
    if (snap.moveCount > 0) {
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
        game: 'chess', // チェスの対局であることを明示（将棋履歴と分離するタグ）
      };
      setHistory(savePlayedGame(played).filter((g) => playedGameKind(g) === 'chess'));
      // 自己用クラウド履歴（unverified）。失敗しても localStorage は残る。
      void (async () => {
        const sync = await syncAiGameToCloud({
          signedIn: authStatus === 'signedIn',
          gameKind: 'chess',
          youColor,
          outcome: humanOutcome,
          result: played.result,
          moveCount: played.moveCount,
          opponentLabel: opponent,
          recordText: pgn,
          idempotencyKey: played.id,
        });
        if (!sync.ok) notifyCloudSyncFailureOnce(sync.reason);
      })();
    }

    /*
     * レート更新(レート戦のみ・この effect は savedCurrentRef で1終局1回が保証済み)。
     * 待った使用時は降格(usedTakebackRef)。相手レート = 難易度の目安 Elo。
     * WHY 0手投了もカウントするか: レート戦を建てて即投了は Elo 上「負け」が正しい
     * (逃げ得を許すとレートが実力とズレる)。カジュアルで気軽に試せるので不便はない。
     * クラウド Elo（apply_rated_result）は ADR 0002 により未配線。
     */
    if (activeRatedRef.current && !usedTakebackRef.current) {
      const score: GameScore = humanOutcome === 'win' ? 1 : humanOutcome === 'draw' ? 0.5 : 0;
      const oppElo = activeDifficultyRef.current.elo;
      setMyRating((prev) => {
        const applied = applyResult(prev.rating, oppElo, score);
        const next: RatingData = { rating: applied.rating, games: prev.games + 1 };
        saveRating(next);
        setRatingResult({ before: prev.rating, after: applied.rating, delta: applied.delta });
        return next;
      });
    }
  }, [snap, youColor, authStatus]);

  // ── レビュー局面からの対局開始(Phase 2B: チェス / Phase 4-3: 将棋) ──
  /*
   * App 経由で playFrom(fen + nonce + kind)が渡されたら、その局面からカジュアル対局を開始する。
   * nonce の変化だけに反応(同一局面の再要求にも応える)。難易度は現在の選択を使う。
   * kind 分岐:
   *   - chess: 従来どおり chess の startGame を FEN で呼ぶ(既存挙動不変)。
   *   - shogi: switchKind('shogi') で将棋タブへ切替え、実際の開始は ShogiPlaySession 側の playFrom
   *     effect に委譲する(下で shogiPlayFrom を prop で渡す)。将棋の対局開始ロジックは
   *     ShogiPlaySession に閉じているため PlayView からは呼べない=責務分離。
   */
  const lastPlayFromNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!playFrom) return;
    if (lastPlayFromNonce.current === playFrom.nonce) return;
    lastPlayFromNonce.current = playFrom.nonce;
    if (playFrom.kind === 'shogi') {
      switchKind('shogi'); // mount + 表示切替。開始は ShogiPlaySession の effect が担う。
      return;
    }
    // チェス経路: 直前に将棋タブを開いていても必ずチェスへ戻してから開始する（Codex ゲート② F001）。
    // これが無いと kind='shogi' のまま chess の startGame が走り、作られたチェス対局が hidden で
    // 見えない（レビュー→チェスの「この局面から対局」に将棋タブ経由で到達したときの回帰）。
    switchKind('chess');
    startGame(colorChoice, difficulty, { startFen: playFrom.fen, rated: false });
    // colorChoice は startFen 時に無視されるが、依存には正直に入れる(値が変わっても再発火しないのは
    // nonce ガードのおかげ。ガードが本質でここの deps は形式)。
  }, [playFrom, startGame, colorChoice, difficulty, switchKind]);

  /*
   * 将棋の入口A用 playFrom を ShogiPlaySession へ渡す形へ変換する。
   * kind='shogi' のときだけ非 null。ShogiPlaySession は nonce の変化で 1 回だけ開始する。
   * WHY ここで組むか: PlayView は SFEN 文字列を素通しするだけで tsshogi に触れない(1 バイト不変条件)。
   */
  const shogiPlayFrom =
    playFrom && playFrom.kind === 'shogi' ? { sfen: playFrom.fen, nonce: playFrom.nonce } : null;

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
      {/* ── [チェス|将棋] 切替（Codex 修正 #1: 共通シェル + kind 別セッション） ──
          ReviewView の kind トグルと同じ aria-pressed イディオム。チェス側は下で「完全にそのまま」
          描画し、将棋側は下で lazy 読み込みする。ここに切替を足すだけ（チェス経路は無改修）。 */}
      <div
        aria-label="ゲーム種別切替"
        className="mb-4 flex w-fit rounded-lg border border-border bg-surface p-0.5"
      >
        {(
          [
            { k: 'chess' as const, label: 'チェス' },
            { k: 'shogi' as const, label: '将棋' },
          ] satisfies { k: GameKind; label: string }[]
        ).map(({ k, label }) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => switchKind(k)}
            className={[
              'focus-ai min-h-8 rounded px-2.5 text-xs font-medium transition-colors',
              kind === k ? 'bg-ai text-white dark:bg-ai-dim' : 'text-muted hover:text-on-surface',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── チェス経路（既存 JSX/ロジックを1挙動も変えない） ──
          hidden で常時マウントし、将棋へ切り替えても進行中のチェス盤 DOM を破棄しない
          （＝チェスの挙動・状態を完全維持）。 */}
      <div className={kind === 'chess' ? '' : 'hidden'}>
        {/* エンジン状態(常時表示。設定/対局どちらでも見える) */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtle">対局相手エンジン: {engineLabel}</span>
        </div>

        {!inGame ? (
          // ═══ 設定画面 ═══
          <SetupScreen
            colorChoice={colorChoice}
            difficulty={difficulty}
            rated={ratedChoice}
            myRating={myRating}
            engineLoading={engineKind === 'loading'}
            onColorChange={setColorChoice}
            onDifficultyChange={setDifficulty}
            onRatedChange={setRatedChoice}
            onStart={() => startGame(colorChoice, difficulty, { rated: ratedChoice })}
            onStartFromFen={(fen) => startGame(colorChoice, difficulty, { startFen: fen })}
            history={history}
            onReviewHistory={(pgn) => onReview({ kind: 'chess', text: pgn })}
            onDeleteHistory={(id) =>
              setHistory(deletePlayedGame(id).filter((g) => playedGameKind(g) === 'chess'))
            }
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
                    name={`${opponentName} ・目安${activeDifficultyRef.current.elo}`}
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
                    // レート戦中はあなたのレートを併記(カジュアルはレート非表示=変動しないことの暗黙表現)
                    name={activeRatedRef.current ? `あなた (${myRating.rating})` : 'あなた'}
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
                  ratingResult={ratingResult}
                  // 0手対局は振り返る棋譜が無い(ChessGame.fromPgn が読めない)ため導線を隠す
                  canReview={snap.moveCount > 0}
                  onReview={() => {
                    const game = gameRef.current;
                    if (game) onReview({ kind: 'chess', text: game.pgn() });
                  }}
                  onRematch={() => startGame(colorChoice, difficulty, { rated: ratedChoice })}
                  onNewGame={handleNewGame}
                />
              )}

              {/* 対局中の操作 */}
              {!isOver && (
                <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-surface-2 p-3 shadow-card">
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
                  {/* レート戦で待ったを使うとレート変動なしに降格したことを明示(公平性の可視化)。
                    ref を render で読むのは通常アンチパターンだが、待った操作は必ず setSnap を
                    伴い再レンダーされるため、この表示は常に最新値を反映する(コメントで担保)。 */}
                  {activeRatedRef.current && usedTakebackRef.current && (
                    <p className="w-full text-[10px] text-subtle" role="note">
                      「待った」を使ったため、この対局はレート変動なしになりました
                    </p>
                  )}
                </div>
              )}

              {/* 棋譜(この対局の手順) */}
              <PlayMoveList moves={snap.history} />
            </aside>
          </div>
        )}
      </div>

      {/* ── 将棋対局セッション（lazy・1バイト不変条件） ──
          初回に将棋タブを選んだときだけ mount し、以降 hidden で保持（進行中の対局を失わない）。
          Suspense fallback はチャンク読込中のプレースホルダ。onReview は kind 対応で受け渡す。 */}
      {shogiMounted && (
        <div className={kind === 'shogi' ? '' : 'hidden'}>
          <Suspense
            fallback={
              <div
                className="h-96 w-full animate-pulse rounded-xl bg-surface-2"
                aria-hidden="true"
              />
            }
          >
            <ShogiPlaySession onReview={onReview} playFrom={shogiPlayFrom} />
          </Suspense>
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

/** 設定画面: 色・難度・レート戦/カジュアルの選択 + FEN開始 + 履歴一覧。 */
function SetupScreen({
  colorChoice,
  difficulty,
  rated,
  myRating,
  engineLoading,
  onColorChange,
  onDifficultyChange,
  onRatedChange,
  onStart,
  onStartFromFen,
  history,
  onReviewHistory,
  onDeleteHistory,
}: {
  colorChoice: ColorChoice;
  difficulty: Difficulty;
  rated: boolean;
  myRating: RatingData;
  engineLoading: boolean;
  onColorChange: (c: ColorChoice) => void;
  onDifficultyChange: (d: Difficulty) => void;
  onRatedChange: (r: boolean) => void;
  onStart: () => void;
  /** FEN 文字列から対局開始(Phase 2B: 詰将棋/練習問題用途。常にカジュアル)。 */
  onStartFromFen: (fen: string) => void;
  history: PlayedGame[];
  onReviewHistory: (pgn: string) => void;
  onDeleteHistory: (id: string) => void;
}) {
  const COLOR_OPTIONS: { value: ColorChoice; label: string }[] = [
    { value: 'white', label: '白（先手）' },
    { value: 'black', label: '黒（後手）' },
    { value: 'random', label: 'ランダム' },
  ];

  // FEN 入力(details 内のローカル state で十分 — 開始したら PlayView 側の状態機械に引き継がれる)
  const [fenText, setFenText] = useState('');
  // 簡易バリデーション: chess.js での本検証は startGame 側。ここでは空/明らかな非FENだけ弾いて
  // ボタンを無効化する(フィールド数 4〜6 の空白区切り + 盤面に '/' を7個含む、程度のゆるい判定)。
  const fenLooksValid = /^[\S]+(\/[\S]+){7}\s+[wb]\s+/.test(fenText.trim());

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* 設定パネル
          shadow-card でカードに浮遊感。
          ヒーローヘッダー: 大きな駒グリフを背景に薄く敷き、ゲーム開始のワクワク感を演出。 */}
      <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface-2 p-5 shadow-card">
        {/* 見出しエリア — relative で装飾グリフの基点になる */}
        <div className="relative">
          {/* 背景装飾: 超薄の藍色ポーンが和紙に溶け込む。
              pointer-events-none / select-none でインタラクションを遮らない。
              opacity-[0.07] = 7%。これ以上濃くすると主役（テキスト）を喰う。 */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-1 -top-2 select-none text-7xl leading-none text-ai opacity-[0.07]"
          >
            ♟
          </span>
          {/* text-lg font-bold: 「対局開始」という行為の重みに合った見出し。
              元の text-base font-semibold より一段上げることで「入口」感を出す。 */}
          <h2 className="text-lg font-bold text-on-surface">AI と対局</h2>
          <p className="mt-1 text-xs text-muted">
            ローカルの Stockfish と対局します。指した対局はこの端末に履歴として保存され、
            あとから1手ずつ振り返れます。
          </p>
          {/* あなたのレート(ローカル内部レート)。レート戦の実績がまだ無くても初期値を見せて
              「レートが動く体験」への期待を作る。 */}
          <p className="mt-2 text-sm">
            <span className="text-muted">あなたのレート: </span>
            <span className="font-bold tabular-nums text-ai">{myRating.rating}</span>
            <span className="ml-1 text-xs text-subtle">
              {myRating.games > 0 ? `（レート戦 ${myRating.games} 局）` : '（初期値）'}
            </span>
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
                  'focus-ai min-h-11 rounded-lg border px-4 text-sm font-medium',
                  /* motion-safe: で reduced-motion ユーザーにはトランジション無効。
                     transition-all で色・影・変形を一括処理。                       */
                  'motion-safe:transition-all motion-safe:duration-150',
                  colorChoice === opt.value
                    ? /* 選択中: shadow-btn で「押し込んだ感」を出す */
                      'border-ai bg-ai text-white shadow-btn dark:bg-ai-dim'
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
                  /* rounded-xl: 元の rounded-lg より角丸を大きくしてカード感を強化 */
                  'focus-ai flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-2 text-center',
                  /* ホバー・選択の変形と影は motion-safe の下にのみ適用。
                     reduced-motion ユーザーには色変化のみ(transition-colors を motion-safe 外に置かない
                     理由: motion-safe: 内に transition-all で統一した方が明示的)。 */
                  'motion-safe:transition-all motion-safe:duration-150',
                  difficulty.key === d.key
                    ? /* 選択中: 藍サーフェス + shadow-card で「浮き上がった」感 */
                      'border-ai bg-ai-bg text-ai shadow-card dark:bg-ai-deep dark:text-ai-muted'
                    : /* 非選択: ホバー時に1px浮かせて「押せる」感を示す */
                      'border-border text-muted hover:border-ai hover:shadow-card motion-safe:hover:-translate-y-px',
                ].join(' ')}
              >
                {/* 駒グリフ: ラベルの上に置いて難度を視覚的に先に伝える。aria-hidden で SR は読まない。 */}
                <span aria-hidden="true" className="text-base leading-none opacity-60">
                  {DIFFICULTY_ICONS[d.key] ?? '♟'}
                </span>
                <span className="text-sm font-semibold">{d.label}</span>
                {/* 目安 Elo(オーナー要望): 数値があると強さの相場観が一目で伝わる。
                    tabular-nums で桁ブレ防止。「~」で目安であることを明示。 */}
                <span className="text-[11px] font-medium tabular-nums opacity-90">~{d.elo}</span>
                <span className="mt-0.5 text-[10px] opacity-80">{d.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* レート戦 / カジュアル切替(オーナー構想: カジュアルはレートが変動しない) */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted">対局の種類</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { v: true, label: 'レート戦', desc: '勝敗でレートが動く' },
                { v: false, label: 'カジュアル', desc: 'レート変動なし' },
              ] as const
            ).map((opt) => (
              <button
                key={String(opt.v)}
                type="button"
                onClick={() => onRatedChange(opt.v)}
                aria-pressed={rated === opt.v}
                className={[
                  'focus-ai flex min-h-11 flex-col items-start justify-center rounded-lg border px-4 py-1',
                  'motion-safe:transition-all motion-safe:duration-150',
                  rated === opt.v
                    ? 'border-ai bg-ai text-white shadow-btn dark:bg-ai-dim'
                    : 'border-border text-muted hover:border-ai hover:text-ai',
                ].join(' ')}
              >
                <span className="text-sm font-medium leading-tight">{opt.label}</span>
                <span className="text-[10px] leading-tight opacity-80">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/*
         * 対局開始ボタン — プライマリCTAとして最も目を引く要素。
         * shadow-btn: 押せる立体感。hover時に shadow-card-hover へ増幅して「浮き上がり」演出。
         * motion-safe: でホバー translate を reduced-motion ユーザーへ適用しない。
         * disabled: shadow を無効化して「押せない」状態を視覚的に正直に伝える。
         */}
        <button
          type="button"
          onClick={onStart}
          disabled={engineLoading}
          className="focus-ai min-h-12 rounded-xl bg-ai px-6 text-base font-semibold text-white shadow-btn hover:bg-ai-hover motion-safe:transition-all motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none dark:bg-ai-dim dark:hover:bg-ai"
        >
          {engineLoading ? 'エンジン読み込み中…' : '対局開始'}
        </button>

        {/* ── FEN から対局(Phase 2B: 詰将棋・練習問題・途中局面) ──
            折りたたみで通常フローを邪魔しない。常にカジュアル(任意局面の有利不利が不明なため)。 */}
        <details className="rounded-xl border border-border bg-surface p-3">
          {/* text-sm + 広いヒット領域(2026-07-11 UI 監査): text-xs では詰将棋・練習用途の入口が埋もれる。 */}
          <summary className="focus-ai -m-2 cursor-pointer rounded p-2 text-sm font-medium text-muted">
            局面(FEN)から対局する — 詰将棋・練習問題向け(カジュアル扱い)
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <input
              value={fenText}
              onChange={(e) => setFenText(e.target.value)}
              placeholder="例: 4k3/8/8/8/8/8/8/R3K3 w - - 0 1"
              spellCheck={false}
              aria-label="開始局面の FEN"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 font-mono text-xs text-on-surface placeholder:text-subtle focus:border-ai focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onStartFromFen(fenText.trim())}
                disabled={engineLoading || !fenLooksValid}
                className="focus-ai min-h-9 rounded-lg border border-ai px-3 text-xs font-medium text-ai transition-colors hover:bg-ai-bg disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-ai-deep"
              >
                この局面から開始
              </button>
              <span className="text-[10px] text-subtle">
                あなたは「その局面の手番側」を持ちます
              </span>
            </div>
          </div>
        </details>
      </section>

      {/* 履歴一覧 */}
      <aside>
        <GameHistory history={history} onReview={onReviewHistory} onDelete={onDeleteHistory} />
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
      {/*
       * アクティブ手番インジケーター — 手番側のプレイヤー名の前に小さな藍ドットを表示。
       * animate-pulse で「今まさに考える番」を視覚的に伝える(reduced-motion の下で自動停止)。
       * aria-hidden: 手番情報は TurnIndicator の aria-live で伝えているため重複させない。
       */}
      {active && (
        <span
          aria-hidden="true"
          className="block h-1.5 w-1.5 shrink-0 rounded-full bg-ai motion-safe:animate-pulse"
        />
      )}
      <span
        className={['text-sm', active ? 'font-semibold text-on-surface' : 'text-muted'].join(' ')}
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
      {/* あなたの色の駒ドット。
          bg-white / bg-black は「プレイヤープレートの駒色ドット」専用の生色例外(CLAUDE.md 記載)。
          AI 思考中かつ続行中のとき motion-safe:animate-pulse で「処理中」を視覚的に示す。
          aria-hidden: 状態は下の aria-live で伝えるため重複させない。 */}
      <span
        aria-hidden="true"
        className={[
          'inline-block h-3 w-3 rounded-full border',
          youColor === 'white' ? 'border-border bg-white' : 'border-border bg-black',
          aiThinking && !isOver ? 'motion-safe:animate-pulse' : '',
        ].join(' ')}
      />
      {/* WHY 思考中は assertive + 藍で強調するか(2026-07-11 UI 監査):
          小さなパルスドットだけだと AI 思考中に「フリーズした」と誤認されやすい(375px で顕著)。
          思考中はテキストを font-medium + text-ai(藍)で視覚的に前へ出し、aria-live も assertive にして
          スクリーンリーダーへ即時通知する(手番の変化は進行上重要度が高い)。それ以外の状態は polite。 */}
      <span
        aria-live={aiThinking && !isOver ? 'assertive' : 'polite'}
        className={aiThinking && !isOver ? 'font-medium text-ai' : ''}
      >
        {text}
      </span>
    </div>
  );
}

/** 終局バナー(結果 + 振り返る/もう一度/新規)。 */
function ResultBanner({
  outcome,
  youColor,
  ratingResult,
  canReview,
  onReview,
  onRematch,
  onNewGame,
}: {
  outcome: Extract<PlaySnapshot['outcome'], { over: true }>;
  youColor: PieceColor;
  /** レート戦の変動結果。null = カジュアル(または待った使用でレート変動なし)。 */
  ratingResult: { before: number; after: number; delta: number } | null;
  /** 振り返り可能か(0手対局は棋譜が無く false)。 */
  canReview: boolean;
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
    // shadow-card: 終局バナーは重要な情報なので他カードより一段「浮いた」感を出す。
    <div className={`rounded-xl border p-4 shadow-card ${tone}`} role="status">
      {/* 勝敗を象徴する駒グリフ + 結果タイトルを横並び。
          WHY チェス記号か: 絵文字(🏆等)は色を持ちデザイン方針「差し色は藍のみ」に抵触する。
          Unicode チェス記号は単色で環境依存が少ない。
          ♛(クイーン) = 勝利、♙(ポーン) = 引き分け(互角の象徴)、♟(黒ポーン) = 敗北。
          aria-hidden: タイトルテキスト(title)で意味は伝わるため重複させない。 */}
      <div className="mb-1 flex items-center gap-2">
        <span aria-hidden="true" className="select-none text-xl leading-none">
          {draw ? '♙' : youWon ? '♛' : '♟'}
        </span>
        <p className="text-lg font-bold text-on-surface">{title}</p>
      </div>
      <p className="text-xs text-muted">{REASON_LABEL[outcome.reason] ?? '終局'}</p>

      {/* レート変動(レート戦のみ)。+は藍・−は柿(悪手と同系)・±0はミュート。
          tabular-nums で数字の幅を固定し「1200 → 1216」の並びを綺麗に見せる。 */}
      {ratingResult && (
        <p className="mt-2 text-sm tabular-nums">
          <span className="text-muted">レート </span>
          <span className="font-semibold text-on-surface">{ratingResult.before}</span>
          <span className="text-muted"> → </span>
          <span className="font-bold text-on-surface">{ratingResult.after}</span>
          <span
            className={[
              'ml-1.5 font-bold',
              ratingResult.delta > 0
                ? 'text-ai'
                : ratingResult.delta < 0
                  ? 'text-[var(--q-miss-fg)]'
                  : 'text-muted',
            ].join(' ')}
          >
            ({ratingResult.delta > 0 ? '+' : ''}
            {ratingResult.delta})
          </span>
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {canReview && (
          <button
            type="button"
            onClick={onReview}
            className="focus-ai min-h-11 rounded-lg bg-ai px-4 text-sm font-semibold text-white transition-colors hover:bg-ai-hover dark:bg-ai-dim dark:hover:bg-ai"
          >
            この対局を振り返る
          </button>
        )}
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
    <div className="rounded-xl border border-border bg-surface-2 p-3 shadow-card">
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
    <div className="rounded-2xl border border-border bg-surface-2 p-4 shadow-card">
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
                className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-card"
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
