import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShogiPlayGame,
  oppositeShogiColor,
  validateStartSfen,
  type ShogiColor,
  type ShogiPlaySnapshot,
} from '../core/shogiPlayGame';
import { ShogiPlayBoard } from './ShogiPlayBoard';
import { createShogiEngine, type ShogiEngineKind } from '../engine/factory';
import type { ChessEngine } from '../engine/types';
import { applyResult, INITIAL_RATING, type GameScore } from '../core/rating';
import {
  loadPlayedGames,
  savePlayedGame,
  deletePlayedGame,
  loadRatingFor,
  saveRatingFor,
  playedGameKind,
  type PlayedGame,
  type RatingData,
} from '../core/storage';
import { useAuth } from '../auth/authState';
import { syncAiGameToCloud } from '../auth/cloudSync';
import { notifyCloudSyncFailureOnce } from '../auth/cloudSyncNotify';

/*
 * ShogiPlaySession — 将棋 AI 対局の自己完結状態機械（React.lazy 到達専用）
 *
 * WHY PlayView(チェス) を再利用せず独立実装するか（Codex ゲート① 質問1回答）:
 *   PlayView は「盤・エンジン・レート・履歴・キャンセルトークン」を密結合に束ねた重い状態機械で、
 *   チェス経路は本番稼働中。ここへ将棋の分岐（打ち・成り選択・千日手・SFEN）を差し込むと、
 *   単一抽象で押し切る負担がチェス回帰リスクへ跳ね返る。よって PlayView の**確立したパターンを
 *   踏襲した独立実装**にする（snapshot in state / mutable in ref・turnToken キャンセル・終局後拒否・
 *   0手対局は履歴保存スキップ・レート戦/待った降格）。「共通シェル(PlayView の kind 切替) + kind 別
 *   セッション」構造の将棋側の本体（Codex 修正 #1）。
 *
 * WHY 動的 import 到達専用か（1バイト不変条件）:
 *   このファイルは ShogiPlayGame/ShogiPlayBoard 経由で tsshogi/shogiground に静的依存する。
 *   PlayView から React.lazy で読み込まれる前提で、チェス利用者のメインチャンクへは 1 バイトも載せない。
 *
 * WHY crossOriginIsolated を UI 側で先に判定するか（Codex 修正 #5）:
 *   やねうら王は SharedArrayBuffer 必須で、credentialless 非対応の Safari では動かない。対局は
 *   「本物のエンジンが指し返す」ことが不可欠なので、factory の mock フォールバック（MockShogiEngine は
 *   chooseMove が null で指せない）に委ねず、UI 側で coi=false を先に検知して開始ボタンを封じる。
 *   （閲覧・棋譜レビューは coi 不要なので、対局のみを塞ぐ非対称は許容 = Phase 4-1 と同じ方針。）
 */

/** 難易度。やねうら王の SkillLevel(弱さ) + movetime(思考時間) にマップする。 */
interface Difficulty {
  key: string;
  label: string;
  /** やねうら王 SkillLevel 0-20。低いほど弱い（chooseMove が NodesLimit も併せて絞る）。 */
  skill: number;
  /** 1手の思考時間(ms)。 */
  movetimeMs: number;
  desc: string;
  /** 目安 Elo（強さ表示 + レート戦の相手レート）。 */
  elo: number;
}

/*
 * 難易度の値の根拠（WHY この数字か）:
 *   SkillLevel はやねうら王がわざと弱く指すレバー（+ NodesLimit で探索量も絞る＝skill×20000 ノード）。
 *   下の elo（強さ表示 + レート戦の相手レート）は当初 chess 流用の暫定値。
 *   2026-07-10 やねうら王 Node ヘッドレス自己対局で相対強度を測った（scripts/measure-shogi-elo.mjs・
 *   16局/ペア。詳細と Codex ゲート②の方法論指摘は docs/PLAN.md「難度Elo実測」節）:
 *     ・順序どおり分離を確認: easy < normal < hard < max（upset なし・各段で下位が大差負け）。
 *     ・normal→hard は 1/16(6%)≒約470 Elo（ただし 16局で信頼区間は広い）。
 *   結論は控えめに（過剰主張しない）: プリセットの**順序と実質的分離は確認**した（難度選択は意味がある）。
 *   ただし 16局・飽和(0/16)・単一開始局面・node-budget 計測のため**正確な Elo 値は tight には確定せず**、
 *   表示 elo（800/1400/1900/2800）は「実測と矛盾しない」水準であって厳密検証済みではない。よって値は
 *   変更しない（過小データに恣意的な新値を当てない）。厳密化するなら MEASURE_MOVETIME=1 + 開始局面多様化
 *   + 局数増（信頼区間付き）で再測定する。絶対 Elo は将棋で基準が曖昧（ウォーズ/81dojo/floodgate で桁違い）
 *   なので「~」目安表記を維持。elo を動かすと rating の変動が変わるので rating.ts と併せて検討。
 */
const DIFFICULTIES: Difficulty[] = [
  { key: 'easy', label: 'やさしい', skill: 2, movetimeMs: 400, desc: '入門〜初心者', elo: 800 },
  { key: 'normal', label: 'ふつう', skill: 8, movetimeMs: 700, desc: '初級〜中級', elo: 1400 },
  { key: 'hard', label: 'つよい', skill: 14, movetimeMs: 1000, desc: '中級〜上級', elo: 1900 },
  { key: 'max', label: '最強', skill: 20, movetimeMs: 1500, desc: 'エンジン全力', elo: 2800 },
];

/*
 * 難度カードの装飾グリフ。将棋駒の強さで難度を直感表現（歩→銀→飛→龍）。
 * 漢字グリフは単色で多色制限に抵触せず、外部フォント不要（shogiBoard.css と同じ思想）。aria-hidden。
 */
const DIFFICULTY_ICONS: Record<string, string> = {
  easy: '歩',
  normal: '銀',
  hard: '飛',
  max: '龍',
};

/** 手番の色選択（random は開始時に確定）。 */
type ColorChoice = 'sente' | 'gote' | 'random';

/** 手番色の日本語ラベル。 */
const COLOR_LABEL: Record<ShogiColor, string> = { sente: '先手', gote: '後手' };

/** 終局理由の日本語ラベル。 */
const REASON_LABEL: Record<string, string> = {
  checkmate: '詰み',
  repetition: '千日手（引き分け）',
  perpetualCheck: '連続王手の千日手',
  resign: '投了',
};

/** ランダム選択を具体的な手番へ解決する（開始時1回のみ・暗号強度不要）。 */
function resolveColor(choice: ColorChoice): ShogiColor {
  if (choice === 'random') return Math.random() < 0.5 ? 'sente' : 'gote';
  return choice;
}

/** 履歴保存用の一意ID（crypto.randomUUID 優先・無ければ時刻+乱数）。 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 将棋の手番色 → PlayedGame.youColor('white'|'black')。sente=先手=盤下=white 相当。 */
function toStorageColor(c: ShogiColor): 'white' | 'black' {
  return c === 'sente' ? 'white' : 'black';
}

/** 終局の勝者 → 絶対表記の result トークン。 */
function resultToken(outcome: ShogiPlaySnapshot['outcome']): string {
  if (!outcome.over) return '*';
  if (outcome.winner === 'sente') return '1-0';
  if (outcome.winner === 'gote') return '0-1';
  return '1/2-1/2';
}

/** crossOriginIsolated（=SharedArrayBuffer 有効）か。Safari(credentialless 非対応)では false。 */
const COI_ENABLED = typeof window !== 'undefined' && window.crossOriginIsolated === true;

interface ShogiPlaySessionProps {
  /** 「この対局を振り返る」で KIF をレビュー画面へ引き渡すコールバック（kind 対応・Codex 修正 #2）。 */
  onReview: (record: { kind: 'shogi'; text: string }) => void;
  /**
   * 入口A（Phase 4-3）: レビュー画面の「この局面から対局」から渡ってくる開始 SFEN + nonce。
   * PlayView が kind='shogi' の playFrom を受けたときだけ非 null を渡す。nonce の変化で 1 回だけ発火。
   * WHY component の外（PlayView）で受けて prop で渡すか: 将棋の対局開始ロジック（エンジン・レート・
   *   turnToken）は本 component に閉じており PlayView から呼べない。PlayView は kind を切り替えて SFEN を
   *   渡すだけで、実際の開始は下の effect が担う（責務分離）。省略時（チェス利用/入口A未使用）は影響なし。
   */
  playFrom?: { sfen: string; nonce: number } | null;
}

/**
 * 将棋 AI 対局セッション本体。PlayView の状態機械を将棋へ写した独立実装。
 * default export は React.lazy から読むため。
 */
export default function ShogiPlaySession({ onReview, playFrom }: ShogiPlaySessionProps) {
  const { status: authStatus } = useAuth();
  // ── エンジン ────────────────────────────────────────────────
  const engineRef = useRef<ChessEngine | null>(null);
  // 'loading' 初期・'unsupported'(coi=false) は create せず即確定。
  const [engineKind, setEngineKind] = useState<ShogiEngineKind | 'loading' | 'unsupported'>(
    COI_ENABLED ? 'loading' : 'unsupported',
  );

  // ── 対局状態（snapshot in state / mutable in ref） ─────────────
  const gameRef = useRef<ShogiPlayGame | null>(null);
  const [snap, setSnap] = useState<ShogiPlaySnapshot | null>(null);

  // 設定
  const [colorChoice, setColorChoice] = useState<ColorChoice>('sente');
  const [difficulty, setDifficulty] = useState<Difficulty>(DIFFICULTIES[1]); // 既定 ふつう
  const [ratedChoice, setRatedChoice] = useState(true);

  // 進行中の対局で確定した値（ref で非同期処理から最新を読む）
  const [youColor, setYouColor] = useState<ShogiColor>('sente');
  const youColorRef = useRef<ShogiColor>('sente');
  youColorRef.current = youColor;
  const activeDifficultyRef = useRef<Difficulty>(difficulty);
  const [orientation, setOrientation] = useState<ShogiColor>('sente');
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState(false);

  // AI 手番のキャンセルトークン（新規/待った/投了/アンマウントで進める）
  const turnTokenRef = useRef(0);
  // 現局面の終局を履歴に保存済みか（二重保存防止）
  const savedCurrentRef = useRef(false);

  // ── 履歴（将棋のみ表示） ────────────────────────────────────
  const [history, setHistory] = useState<PlayedGame[]>([]);

  // ── ローカル内部レート（将棋専用枠 cj:rating:shogi・Codex 修正 #3） ──
  const [myRating, setMyRating] = useState<RatingData>(
    () => loadRatingFor('shogi') ?? { rating: INITIAL_RATING, games: 0 },
  );
  const activeRatedRef = useRef(false);
  const usedTakebackRef = useRef(false);
  const [ratingResult, setRatingResult] = useState<{
    before: number;
    after: number;
    delta: number;
  } | null>(null);

  // ── エンジン初期化（coi 有効時のみ。PlayView と同型の別インスタンス管理） ──
  useEffect(() => {
    if (!COI_ENABLED) return; // 非対応環境は create しない（unsupported 確定済み）
    let disposed = false;
    const tokenRef = turnTokenRef;
    createShogiEngine().then(({ engine, kind }) => {
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      setEngineKind(kind);
    });
    return () => {
      disposed = true;
      ++tokenRef.current; // 進行中の AI 応答を無効化してから解放
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // ── 履歴の初期ロード（将棋のみ） ────────────────────────────
  useEffect(() => {
    setHistory(loadShogiHistory());
  }, []);

  // ── AI に1手指させる ────────────────────────────────────────
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
      const usi = await engine.chooseMove(game.sfen, {
        skill: diff.skill,
        movetimeMs: diff.movetimeMs,
      });
      // await の間にキャンセルされていたら破棄（新規/待った/投了/アンマウント）
      if (myToken !== turnTokenRef.current) return;
      if (!usi) {
        // null = bestmove が resign/win/none(実手なし)。既に終局(詰み等)なら outcome が
        // 真実を語るので何もしない。**続行中に null が来た場合は AI の投了として扱う**
        // (Codex ゲート② nice-to-have: 放置すると AI 手番のまま無音停止する)。
        // やねうら王は劣勢で本当に `bestmove resign` を返すので、これは実際に踏む経路。
        if (!game.outcome().over) {
          game.resign(oppositeShogiColor(youColorRef.current));
          setSnap(game.snapshot());
        }
        return;
      }
      if (!game.applyUsi(usi)) {
        // 不正 USI(エンジン異常)。無音で固まらせず再試行導線のあるエラー表示へ倒す。
        setAiError(true);
        return;
      }
      setSnap(game.snapshot());
    } catch {
      // エンジンエラー（timeout/worker 終了等）。無言で固まらないようフラグを立てる。
      if (myToken === turnTokenRef.current) setAiError(true);
    } finally {
      if (myToken === turnTokenRef.current) setAiThinking(false);
    }
  }, []);

  // ── ユーザーの着手 ──────────────────────────────────────────
  const handleUserMove = useCallback(
    (from: string, to: string, promote?: boolean) => {
      const game = gameRef.current;
      if (!game) return;
      if (aiThinking) return; // 思考中はロックしているが保険
      if (game.outcome().over) return; // 終局後は着手しない（core も弾くが二重に守る）
      if (game.turn !== youColorRef.current) return;

      const ok = game.move(from, to, promote);
      setSnap(game.snapshot()); // 非合法でも現局面へ再同期
      if (!ok) return;
      if (!game.outcome().over) void runAiMove();
    },
    [aiThinking, runAiMove],
  );

  // ── ユーザーの駒台打ち ──────────────────────────────────────
  const handleUserDrop = useCallback(
    (role: string, to: string) => {
      const game = gameRef.current;
      if (!game) return;
      if (aiThinking) return;
      if (game.outcome().over) return;
      if (game.turn !== youColorRef.current) return;

      const ok = game.drop(role, to);
      setSnap(game.snapshot());
      if (!ok) return;
      if (!game.outcome().over) void runAiMove();
    },
    [aiThinking, runAiMove],
  );

  // ── 対局開始 ────────────────────────────────────────────────
  // opts.startSfen（Phase 4-3・局面から対局）: 指定時はその SFEN から開始する。呼び出し側（設定の
  //   SFEN 入力 / 入口A の effect）が validateStartSfen で事前検証済みの前提だが、constructor も
  //   不正時は平手へ自衛フォールバックする（:171-175）。チェス PlayView.startGame の opts と同型。
  const startGame = useCallback(
    (choice: ColorChoice, diff: Difficulty, opts?: { startSfen?: string; rated?: boolean }) => {
      const startSfen = opts?.startSfen;
      const game = new ShogiPlayGame(startSfen);
      // SFEN 指定時は「その局面の手番側」をあなたに割り当てる（色選択を無視）。チェス :338-339 と対称。
      const color = startSfen ? game.turn : resolveColor(choice);

      // 同期的に ref を確定（runAiMove が即参照できるように state 更新前に入れる）
      gameRef.current = game;
      youColorRef.current = color;
      activeDifficultyRef.current = diff;
      // SFEN 対局は常にカジュアル（任意局面の有利不利が不明でレート戦にできない）。チェス :346 と対称。
      activeRatedRef.current = Boolean(opts?.rated) && !startSfen;
      usedTakebackRef.current = false;
      ++turnTokenRef.current; // 前局の AI 応答を無効化
      savedCurrentRef.current = false;

      setYouColor(color);
      setOrientation(color);
      setAiThinking(false);
      setAiError(false);
      setRatingResult(null);
      setSnap(game.snapshot());

      // AI が先手（あなたが後手）なら開始と同時に AI の初手。
      if (game.turn !== color) void runAiMove();
    },
    [runAiMove],
  );

  // ── 入口A（Phase 4-3）: レビュー局面からの対局開始 ────────────
  /*
   * PlayView 経由で playFrom(sfen + nonce) が渡されたら、その局面からカジュアル対局を開始する。
   * チェス PlayView.tsx:468-476 の Phase 2B effect と同型（nonce の変化だけに反応）。
   * ガード:
   *   - COI_ENABLED（SharedArrayBuffer）が無い環境では開始しない。エンジンが指せないので設定画面に留め、
   *     既存の unsupported 告知で理由を見せる（黙って始めて AI が無応答、を避ける）。
   *   - validateStartSfen で二段防御（レビュー由来 SFEN は常に合法だが、想定外入力を弾く）。
   */
  const lastPlayFromNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!playFrom) return;
    if (lastPlayFromNonce.current === playFrom.nonce) return;
    lastPlayFromNonce.current = playFrom.nonce;
    if (!COI_ENABLED) return; // 非対応環境は開始しない（設定画面の unsupported 告知に委ねる）
    if (!validateStartSfen(playFrom.sfen).ok) return; // 二段防御
    startGame(colorChoice, difficulty, { startSfen: playFrom.sfen, rated: false });
    // colorChoice/difficulty は startSfen 時に色が無視される。deps には正直に入れる（nonce ガードが本質）。
  }, [playFrom, startGame, colorChoice, difficulty]);

  // ── 投了 ────────────────────────────────────────────────────
  const handleResign = useCallback(() => {
    const game = gameRef.current;
    if (!game || game.outcome().over) return;
    ++turnTokenRef.current;
    setAiThinking(false);
    game.resign(youColorRef.current);
    setSnap(game.snapshot());
  }, []);

  // ── 待った（1ラウンド戻す） ──────────────────────────────────
  const handleTakeback = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    ++turnTokenRef.current;
    game.clearResign(); // 防御: 終局状態からでも巻き戻せるように（通常は no-op）
    if (!game.undo()) return; // 戻す手が無ければ何もしない
    usedTakebackRef.current = true; // 待った使用でレート変動なしに降格（公平性）
    // 戻した結果が AI の手番なら、自分の手番になるようもう1手戻す
    if (game.turn !== youColorRef.current) game.undo();
    savedCurrentRef.current = false;
    setAiThinking(false);
    setAiError(false);
    setSnap(game.snapshot());
    // 戻した後が AI の手番なら AI に指させ直す
    if (!game.outcome().over && game.turn !== youColorRef.current) void runAiMove();
  }, [runAiMove]);

  // ── 設定へ戻る（対局を破棄） ──────────────────────────────────
  const handleNewGame = useCallback(() => {
    ++turnTokenRef.current;
    gameRef.current = null;
    savedCurrentRef.current = false;
    setAiThinking(false);
    setAiError(false);
    setSnap(null);
    setHistory(loadShogiHistory()); // 直前対局が保存されている可能性
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

    // 0手対局（即投了）は棋譜が無いので履歴保存をスキップ（KIF が読めず「振り返る」が壊れる。
    // PlayView と同じ規律）。レート戦のレート減算は下で通常どおり行う（即投了の逃げ得防止）。
    if (snap.moveCount > 0) {
      const kif = game.exportKif({
        black: youColor === 'sente' ? 'あなた' : opponent,
        white: youColor === 'gote' ? 'あなた' : opponent,
        title: 'AI 戦',
      });
      const played: PlayedGame = {
        id: newId(),
        createdAt: Date.now(),
        pgn: kif, // フィールド名は歴史的に "pgn"。将棋は KIF を格納（storage.ts のコメント参照）
        result: resultToken(outcome),
        outcome: humanOutcome,
        youColor: toStorageColor(youColor),
        opponent,
        moveCount: snap.moveCount,
        game: 'shogi', // ← このタグでチェス履歴と分離
      };
      setHistory(savePlayedGame(played).filter((g) => playedGameKind(g) === 'shogi'));
      void (async () => {
        const sync = await syncAiGameToCloud({
          signedIn: authStatus === 'signedIn',
          gameKind: 'shogi',
          youColor: played.youColor,
          outcome: humanOutcome,
          result: played.result,
          moveCount: played.moveCount,
          opponentLabel: opponent,
          recordText: kif,
          idempotencyKey: played.id,
        });
        if (!sync.ok) notifyCloudSyncFailureOnce(sync.reason);
      })();
    }

    // レート更新（レート戦のみ・待った未使用のみ・将棋専用枠へ保存）。
    // クラウド Elo は ADR 0002 により未配線。
    if (activeRatedRef.current && !usedTakebackRef.current) {
      const score: GameScore = humanOutcome === 'win' ? 1 : humanOutcome === 'draw' ? 0.5 : 0;
      const oppElo = activeDifficultyRef.current.elo;
      setMyRating((prev) => {
        const applied = applyResult(prev.rating, oppElo, score);
        const next: RatingData = { rating: applied.rating, games: prev.games + 1 };
        saveRatingFor('shogi', next);
        setRatingResult({ before: prev.rating, after: applied.rating, delta: applied.delta });
        return next;
      });
    }
  }, [snap, youColor, authStatus]);

  // ── 派生値 ──────────────────────────────────────────────────
  const isOver = snap?.outcome.over ?? false;
  const inGame = snap !== null;
  const oppColor = oppositeShogiColor(youColor);
  const opponentName = `AI (${activeDifficultyRef.current.label})`;
  // 盤を操作できるのは「自分の手番・思考中でない・続行中」のときだけ
  const canMove = Boolean(snap && !isOver && !aiThinking && snap.turn === youColor);

  const engineReady = engineKind === 'yaneuraou';
  const engineLabel =
    engineKind === 'loading'
      ? '読み込み中…'
      : engineKind === 'yaneuraou'
        ? 'やねうら王 WASM'
        : engineKind === 'unsupported'
          ? 'エンジン非対応（この端末では対局不可）'
          : 'エンジン読込失敗';

  // ── 描画 ────────────────────────────────────────────────────
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle">対局相手エンジン: {engineLabel}</span>
      </div>

      {!inGame ? (
        <ShogiSetupScreen
          colorChoice={colorChoice}
          difficulty={difficulty}
          rated={ratedChoice}
          myRating={myRating}
          engineReady={engineReady}
          engineKind={engineKind}
          onColorChange={setColorChoice}
          onDifficultyChange={setDifficulty}
          onRatedChange={setRatedChoice}
          onStart={() => startGame(colorChoice, difficulty, { rated: ratedChoice })}
          onStartFromSfen={(sfen) => startGame(colorChoice, difficulty, { startSfen: sfen })}
          history={history}
          onReviewHistory={(kif) => onReview({ kind: 'shogi', text: kif })}
          onDeleteHistory={(id) =>
            setHistory(deletePlayedGame(id).filter((g) => playedGameKind(g) === 'shogi'))
          }
        />
      ) : (
        // ═══ 対局画面 ═══
        snap && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section className="flex flex-col gap-4">
              <div className="mx-auto w-full max-w-[500px]">
                <ShogiPlayerPlate
                  name={`${opponentName}・目安${activeDifficultyRef.current.elo}`}
                  color={oppColor}
                  active={!isOver && snap.turn !== youColor}
                  inCheck={!isOver && snap.inCheck && snap.turn === oppColor}
                />
                <ShogiPlayBoard
                  sfen={snap.sfen}
                  orientation={orientation}
                  turnColor={snap.turn}
                  inCheck={snap.inCheck}
                  lastMoveUsi={snap.lastMoveUsi}
                  legalDests={snap.legalDests}
                  dropDests={snap.dropDests}
                  movable={canMove}
                  needsPromotionChoice={(from, to) =>
                    gameRef.current?.needsPromotionChoice(from, to) ?? false
                  }
                  onUserMove={handleUserMove}
                  onUserDrop={handleUserDrop}
                />
                <ShogiPlayerPlate
                  name={activeRatedRef.current ? `あなた (${myRating.rating})` : 'あなた'}
                  color={youColor}
                  active={!isOver && snap.turn === youColor}
                  inCheck={!isOver && snap.inCheck && snap.turn === youColor}
                />
              </div>

              {/* 手番/状態インジケータ + 盤反転 */}
              <div className="mx-auto flex w-full max-w-[500px] items-center justify-between gap-2">
                <ShogiTurnIndicator
                  isOver={isOver}
                  aiThinking={aiThinking}
                  yourTurn={snap.turn === youColor}
                  youColor={youColor}
                />
                <button
                  type="button"
                  onClick={() => setOrientation((o) => oppositeShogiColor(o))}
                  aria-label={`盤を反転（現在: ${orientation === 'sente' ? '先手目線' : '後手目線'}）`}
                  title="盤を反転"
                  className="focus-ai min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface-2"
                >
                  ⇅
                </button>
              </div>

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
              {isOver && snap.outcome.over && (
                <ShogiResultBanner
                  outcome={snap.outcome}
                  youColor={youColor}
                  ratingResult={ratingResult}
                  canReview={snap.moveCount > 0}
                  onReview={() => {
                    const game = gameRef.current;
                    if (game) onReview({ kind: 'shogi', text: game.exportKif() });
                  }}
                  onRematch={() => startGame(colorChoice, difficulty, { rated: ratedChoice })}
                  onNewGame={handleNewGame}
                />
              )}

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
                  {activeRatedRef.current && usedTakebackRef.current && (
                    <p className="w-full text-[10px] text-subtle" role="note">
                      「待った」を使ったため、この対局はレート変動なしになりました
                    </p>
                  )}
                </div>
              )}

              <ShogiMoveList moves={snap.history} />
            </aside>
          </div>
        )
      )}
    </div>
  );
}

/** localStorage から将棋の対局履歴だけを新しい順で読む（チェス履歴は混ぜない）。 */
function loadShogiHistory(): PlayedGame[] {
  return loadPlayedGames().filter((g) => playedGameKind(g) === 'shogi');
}

/* ══════════════════════════════════════════════════════════════
 * 以下、ShogiPlaySession 内でのみ使う表示専用の小コンポーネント群。
 * PlayView と同じく、状態と密結合で単体再利用しないためファイル分割しない（コヒーレンス優先）。
 * ════════════════════════════════════════════════════════════ */

/** 設定画面: 手番・難度・レート戦/カジュアル + 将棋対局履歴。 */
function ShogiSetupScreen({
  colorChoice,
  difficulty,
  rated,
  myRating,
  engineReady,
  engineKind,
  onColorChange,
  onDifficultyChange,
  onRatedChange,
  onStart,
  onStartFromSfen,
  history,
  onReviewHistory,
  onDeleteHistory,
}: {
  colorChoice: ColorChoice;
  difficulty: Difficulty;
  rated: boolean;
  myRating: RatingData;
  engineReady: boolean;
  engineKind: ShogiEngineKind | 'loading' | 'unsupported';
  onColorChange: (c: ColorChoice) => void;
  onDifficultyChange: (d: Difficulty) => void;
  onRatedChange: (r: boolean) => void;
  onStart: () => void;
  /** 入口B（Phase 4-3）: 貼付 SFEN からカジュアル対局を開始する。 */
  onStartFromSfen: (sfen: string) => void;
  history: PlayedGame[];
  onReviewHistory: (kif: string) => void;
  onDeleteHistory: (id: string) => void;
}) {
  const COLOR_OPTIONS: { value: ColorChoice; label: string }[] = [
    { value: 'sente', label: '先手' },
    { value: 'gote', label: '後手' },
    { value: 'random', label: 'ランダム' },
  ];

  // 入口B: 「局面(SFEN)から対局」の入力状態。validateStartSfen で開始可否と理由を判定する。
  const [sfenText, setSfenText] = useState('');
  const sfenTrimmed = sfenText.trim();
  const sfenValidation = sfenTrimmed ? validateStartSfen(sfenTrimmed) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface-2 p-5 shadow-card">
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-1 -top-2 select-none text-7xl leading-none text-ai opacity-[0.07]"
          >
            歩
          </span>
          <h2 className="text-lg font-bold text-on-surface">やねうら王と対局</h2>
          <p className="mt-1 text-xs text-muted">
            ローカルのやねうら王（水匠）と対局します。指した対局はこの端末に履歴として保存され、
            あとから1手ずつ振り返れます。
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted">あなたのレート（将棋）: </span>
            <span className="font-bold tabular-nums text-ai">{myRating.rating}</span>
            <span className="ml-1 text-xs text-subtle">
              {myRating.games > 0 ? `（レート戦 ${myRating.games} 局）` : '（初期値）'}
            </span>
          </p>
        </div>

        {/* 非対応環境（Safari 等・coi=false）の告知（Codex 修正 #5）。開始は封じる。 */}
        {engineKind === 'unsupported' && (
          <div
            role="note"
            className="rounded-xl border border-[var(--q-miss-fg)] bg-[var(--q-miss-bg)] px-4 py-2.5 text-xs text-[var(--q-miss-fg)]"
          >
            このブラウザは将棋エンジンに未対応のため、AI
            対局はできません（チェス対局・将棋の棋譜閲覧は可能です）。 Chrome / Edge など
            SharedArrayBuffer 対応ブラウザでご利用ください。
          </div>
        )}

        {/* 手番 */}
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
                  'motion-safe:transition-all motion-safe:duration-150',
                  colorChoice === opt.value
                    ? 'border-ai bg-ai text-white shadow-btn dark:bg-ai-dim'
                    : 'border-border text-muted hover:border-ai hover:text-ai',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 難度 */}
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
                  'focus-ai flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-2 text-center',
                  'motion-safe:transition-all motion-safe:duration-150',
                  difficulty.key === d.key
                    ? 'border-ai bg-ai-bg text-ai shadow-card dark:bg-ai-deep dark:text-ai-muted'
                    : 'border-border text-muted hover:border-ai hover:shadow-card motion-safe:hover:-translate-y-px',
                ].join(' ')}
              >
                <span aria-hidden="true" className="text-base leading-none opacity-60">
                  {DIFFICULTY_ICONS[d.key] ?? '歩'}
                </span>
                <span className="text-sm font-semibold">{d.label}</span>
                {/* 目安 Elo。「~」で目安（暫定・要実測）であることを明示。 */}
                <span className="text-[11px] font-medium tabular-nums opacity-90">~{d.elo}</span>
                <span className="mt-0.5 text-[10px] opacity-80">{d.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* レート戦 / カジュアル */}
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

        <button
          type="button"
          onClick={onStart}
          disabled={!engineReady}
          className="focus-ai min-h-12 rounded-xl bg-ai px-6 text-base font-semibold text-white shadow-btn hover:bg-ai-hover motion-safe:transition-all motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none dark:bg-ai-dim dark:hover:bg-ai"
        >
          {engineKind === 'loading'
            ? 'エンジン読み込み中…'
            : engineKind === 'unsupported'
              ? 'この端末では対局できません'
              : engineKind === 'mock'
                ? 'エンジン読込に失敗しました'
                : '対局開始'}
        </button>

        {/* ── 入口B: 局面(SFEN)から対局（Phase 4-3: 詰将棋・練習・途中局面） ──
            折りたたみで通常フローを邪魔しない。チェス PlayView の FEN 入力（:925-954）の写像。
            常にカジュアル（任意局面の有利不利が不明）。エンジン非対応環境では開始を封じる。 */}
        <details className="rounded-xl border border-border bg-surface p-3">
          {/* text-sm + 広いヒット領域(2026-07-11 UI 監査・PlayView の FEN 入口と対称)。 */}
          <summary className="focus-ai -m-2 cursor-pointer rounded p-2 text-sm font-medium text-muted">
            局面(SFEN)から対局する — 詰将棋・練習問題向け(カジュアル扱い)
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <input
              value={sfenText}
              onChange={(e) => setSfenText(e.target.value)}
              placeholder="例: lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
              spellCheck={false}
              aria-label="開始局面の SFEN"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 font-mono text-xs text-on-surface placeholder:text-subtle focus:border-ai focus:outline-none"
            />
            {/* 不正 SFEN・片玉・重複玉は理由を出して開始を封じる（Codex ゲート① F002）。 */}
            {sfenValidation && !sfenValidation.ok && (
              <p role="alert" className="text-[11px] text-[var(--q-miss-fg)]">
                {sfenValidation.reason}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onStartFromSfen(sfenTrimmed)}
                disabled={!engineReady || !sfenValidation?.ok}
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

      <aside>
        <ShogiGameHistory history={history} onReview={onReviewHistory} onDelete={onDeleteHistory} />
      </aside>
    </div>
  );
}

/**
 * プレイヤープレート（将棋）— 名前 + 手番ドット + 王手表示。
 * 持ち駒は盤の inlined hands で見えるので、プレートは軽量に保つ（名前・手番・王手のみ）。
 */
function ShogiPlayerPlate({
  name,
  color,
  active,
  inCheck,
}: {
  name: string;
  color: ShogiColor;
  active: boolean;
  inCheck: boolean;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 px-1 py-0.5">
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
      <span className="text-xs text-subtle">{COLOR_LABEL[color]}</span>
      {inCheck && (
        <span className="text-xs font-bold text-[var(--q-miss-fg)]" role="status">
          王手
        </span>
      )}
    </div>
  );
}

/** 手番/状態のインジケータ。 */
function ShogiTurnIndicator({
  isOver,
  aiThinking,
  yourTurn,
  youColor,
}: {
  isOver: boolean;
  aiThinking: boolean;
  yourTurn: boolean;
  youColor: ShogiColor;
}) {
  let text: string;
  if (isOver) text = '対局終了';
  else if (aiThinking) text = 'AI が考えています…';
  else if (yourTurn) text = 'あなたの番';
  else text = 'AI の番';

  return (
    <div className="flex items-center gap-2 text-sm text-on-surface">
      <span
        aria-hidden="true"
        className={[
          'inline-block h-3 w-3 rounded-full border border-border',
          youColor === 'sente' ? 'bg-white' : 'bg-black',
          aiThinking && !isOver ? 'motion-safe:animate-pulse' : '',
        ].join(' ')}
      />
      {/* 思考中の強調 + assertive 通知(2026-07-11 UI 監査・PlayView と対称)。
          小さなパルスドットのみだと AI 思考中に固まったと誤認されやすいので、思考中は
          font-medium + 藍で前へ出し aria-live を assertive にする。それ以外は polite。 */}
      <span
        aria-live={aiThinking && !isOver ? 'assertive' : 'polite'}
        className={aiThinking && !isOver ? 'font-medium text-ai' : ''}
      >
        {text}
      </span>
    </div>
  );
}

/** 終局バナー（結果 + 振り返る/もう一度/新規）。 */
function ShogiResultBanner({
  outcome,
  youColor,
  ratingResult,
  canReview,
  onReview,
  onRematch,
  onNewGame,
}: {
  outcome: Extract<ShogiPlaySnapshot['outcome'], { over: true }>;
  youColor: ShogiColor;
  ratingResult: { before: number; after: number; delta: number } | null;
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
    <div className={`rounded-xl border p-4 shadow-card ${tone}`} role="status">
      <div className="mb-1 flex items-center gap-2">
        {/* 将棋駒グリフで勝敗を象徴（単色・多色制限に抵触しない）。玉=勝ち/歩=引分/と=負け。 */}
        <span aria-hidden="true" className="select-none text-xl leading-none">
          {draw ? '歩' : youWon ? '玉' : 'と'}
        </span>
        <p className="text-lg font-bold text-on-surface">{title}</p>
      </div>
      <p className="text-xs text-muted">{REASON_LABEL[outcome.reason] ?? '終局'}</p>

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

/** この対局の棋譜（日本語表記のペア並び・読み取り専用）。 */
function ShogiMoveList({ moves }: { moves: ShogiPlaySnapshot['history'] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [moves.length]);

  const rows: { no: number; sente?: string; gote?: string }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ no: i / 2 + 1, sente: moves[i]?.label, gote: moves[i + 1]?.label });
  }

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-3 shadow-card">
      <h3 className="mb-2 text-xs font-semibold text-muted">棋譜</h3>
      {moves.length === 0 ? (
        <p className="text-xs text-subtle">まだ手がありません</p>
      ) : (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.no} className="border-b border-border last:border-0">
                  <td className="w-8 py-0.5 pr-2 text-right text-xs text-subtle select-none">
                    {r.no}.
                  </td>
                  <td className="py-0.5 pr-2">{r.sente ?? ''}</td>
                  <td className="py-0.5">{r.gote ?? ''}</td>
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

/** 過去の将棋対局の履歴一覧（振り返る/削除）。 */
function ShogiGameHistory({
  history,
  onReview,
  onDelete,
}: {
  history: PlayedGame[];
  onReview: (kif: string) => void;
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
      <h2 className="text-sm font-semibold text-on-surface">将棋の対局履歴</h2>
      {history.length === 0 ? (
        <p className="mt-2 text-xs text-subtle">
          まだ将棋の対局がありません。左で設定して「対局開始」を押してください。
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
                      {g.opponent}・{g.youColor === 'white' ? '先手' : '後手'}・{g.moveCount}手
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
