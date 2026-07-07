import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessGame } from '../core/game';
import { buildExplanationContext } from '../core/classify';
import { computeAccuracySummary } from '../core/evalUtils';
import type { ExplanationContext, KnowledgeProfile, MoveQuality } from '../core/types';
import type { ChessEngine } from '../engine/types';
import { createEngine, type EngineKind } from '../engine/factory';
import { requestExplanation } from '../explain/client';
import {
  hashPgn,
  loadContextsFromStorage,
  saveContextsToStorage,
  loadSessionFromStorage,
  saveSessionToStorage,
  encodePgnForUrl,
  decodePgnFromUrl,
} from '../core/storage';
import { Board } from './Board';
import { EvalBar } from './EvalBar';
import { EvalGraph } from './EvalGraph';
import { MoveList } from './MoveList';
import { AccuracySummary } from './AccuracySummary';
import { ExplanationPanel, type ChatTurn } from './ExplanationPanel';
import { SAMPLE_PGN, SAMPLE_GAMES } from './sample';

const LEVELS: KnowledgeProfile['level'][] = ['beginner', 'intermediate', 'advanced'];
const LEVEL_LABEL: Record<NonNullable<KnowledgeProfile['level']>, string> = {
  beginner: '初心者',
  intermediate: '中級',
  advanced: '上級',
};

/**
 * 共有URLに含められる PGN の最大文字数。
 * 5000文字 ≈ base64url で約 7000文字。一般的なブラウザの URL 上限 (≈2MB) より十分小さい。
 * 短い対局(〜100手)はほぼ全て収まる。超過時はコピーボタンを無効化+注記で通知する。
 */
const SHARE_MAX_PGN_CHARS = 5000;

/*
 * ReviewView — 棋譜振り返り画面
 *
 * レイアウト:
 *   モバイル: 縦スタック(盤 → 解説パネル)
 *   lg+:      2カラム(盤 | 手順表・解説)
 *
 * 主な状態:
 *   - game:               ChessGame インスタンス(PGN読込後)
 *   - index:              現在表示中の手番(0=開始局面, k=k手目直後)
 *   - contexts:           ply → ExplanationContext (エンジン解析結果キャッシュ)
 *   - analyzeAllProgress: 全手解析の進捗 {done, total} | null
 *   - orientation:        盤の向き 'white' | 'black'
 *   - loadedPgn:          最後に正常ロードできた PGN テキスト(localStorage 保存用)
 *   - hintDismissed:      使い方ヒントバナーを閉じたか
 *   - autoExplain:        手を進めたら自動解説(既定 OFF)
 *
 * キャンセルトークン方式:
 *   - analyzeToken: 単手解析(useEffect)用。手の変更や棋譜再読み込みでキャンセル。
 *   - bulkTokenRef: 全手解析(handleAnalyzeAll)用。別管理することで
 *     ナビゲーション(setIndex)が全手解析を中断しないようにしている。
 *     棋譜再読み込み(loadPgn)とアンマウントでのみ中断。
 *
 * localStorage 永続化:
 *   - セッション(最後の PGN・level・orientation・ヒント既読)を起動時に復元。
 *   - 解析済みコンテキストを PGN ハッシュキーで保存。同一棋譜を再ロード時は
 *     再解析なしに badges/グラフ/精度を即復元する。
 *   - QuotaExceeded/破損は try/catch で握り、UI への影響ゼロ。
 *
 * 起動時の PGN ロード優先順位:
 *   1. URL ハッシュ (#g=<base64url>) — 共有リンクから開いた場合
 *   2. localStorage セッション — 前回終了時の棋譜
 *   3. SAMPLE_PGN の自動ロード — 初回訪問・セッションなし
 */

/**
 * @param initialPgn 対局(PlayView)からの「振り返る」で渡される PGN。
 *   指定時は URL ハッシュ・セッション・サンプルより優先してこの棋譜をロードする。
 *   App は振り返りのたびに key を変えて ReviewView を再マウントするため、この prop は
 *   マウント毎に固定値になる(=マウント時初期化ロジックだけで正しく反映される)。
 * @param active このビューが現在表示中か(既定 true)。
 *   WHY 必要か: App は「一度開いたら以降 unmount せず hidden で保持」する(対局中の状態を守るため)。
 *   その結果、対局タブに戻っても ReviewView は生き続ける。可視判定なしだと、非表示中でも
 *   document レベルの keydown(←/→/Home/End)を横取りして対局のキー操作やページスクロールを
 *   潰してしまう(reviewer 指摘の回帰)。active=false のときはグローバルリスナーを張らない。
 */
export function ReviewView({
  initialPgn,
  active = true,
  onPlayFrom,
}: {
  initialPgn?: string;
  active?: boolean;
  /**
   * 「この局面から対局」(Phase 2B)。現在表示中の局面 FEN を対局画面へ引き渡す。
   * 未指定なら導線ボタン自体を出さない(単体利用やテストで PlayView が無い構成を壊さない)。
   */
  onPlayFrom?: (fen: string) => void;
} = {}) {
  const [pgnText, setPgnText] = useState(initialPgn ?? SAMPLE_PGN);
  const [game, setGame] = useState<ChessGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [engineKind, setEngineKind] = useState<EngineKind | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');

  const [contexts, setContexts] = useState<Record<number, ExplanationContext>>({});
  const [explanations, setExplanations] = useState<Record<number, string>>({});
  const [threads, setThreads] = useState<Record<number, ChatTurn[]>>({});
  const [level, setLevel] = useState<NonNullable<KnowledgeProfile['level']>>('beginner');

  // 最後に正常ロードした PGN(セッション保存・コンテキスト保存のキー)
  const [loadedPgn, setLoadedPgn] = useState<string | null>(null);

  // ヒントバナー既読状態
  const [hintDismissed, setHintDismissed] = useState(false);

  // 自動解説トグル(既定 OFF — コスト暴発防止)
  const [autoExplain, setAutoExplain] = useState(false);

  // 共有リンクコピー状態(コピー後 2 秒間フィードバック表示)
  const [shareCopied, setShareCopied] = useState(false);

  // 全手解析の進捗 (null = 非実行中)
  const [analyzeAllProgress, setAnalyzeAllProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const engineRef = useRef<ChessEngine | null>(null);
  // 単手解析のキャンセルトークン
  const analyzeToken = useRef(0);
  // 全手解析のキャンセルトークン(ナビゲーションに影響されない)
  const bulkTokenRef = useRef(0);
  // 全手解析の二重起動ガード
  const isAnalyzingAllRef = useRef(false);

  // ── 自動解説用 ref(stale closure 対策) ─────────────────────
  // timeout 内でも最新の状態を参照できるよう ref に同期する。
  // WHY useEffect でなく直接代入か: effect だとレンダー後に更新されるが、
  // ここでは render phase での同期が必要なため直接代入で OK。
  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;
  const explanationsRef = useRef(explanations);
  explanationsRef.current = explanations;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // onExplain の最新版を ref に保持(onExplain 自体はレンダーごとに再生成される)
  const onExplainRef = useRef<(() => Promise<void>) | null>(null);

  // ── エンジン初期化 ──────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
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
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // アンマウント時に全手解析をキャンセルする専用 cleanup。
  // WHY 分離: エンジン cleanup と混在させると react-hooks/exhaustive-deps が
  // 「ref.current をクリーンアップ内で使うな」と警告するため別 effect にする。
  useEffect(() => {
    const ref = bulkTokenRef;
    return () => {
      ++ref.current;
    };
  }, []);

  // ── 棋譜ロードのコア関数 ────────────────────────────────────
  /*
   * loadPgn — PGN 文字列から ChessGame を構築し状態を更新する。
   *
   * useCallback の deps が [] なのは WHY:
   *   setGame 等の useState setter はコンポーネントのライフタイム中で安定しているため
   *   deps 省略で OK。ref 経由の操作も同様。
   *   (eslint-plugin-react-hooks は安定 setter を自動で判断するため警告も出ない)
   *
   * restoreCtx=true の場合、PGN ハッシュで localStorage から解析結果を復元する。
   * 同一棋譜をリロードしても再解析が不要になる。
   */
  const loadPgn = useCallback(
    (pgn: string, opts?: { restoreCtx?: boolean }) => {
      try {
        const g = ChessGame.fromPgn(pgn);
        if (g.length === 0) throw new Error('手が見つかりません');

        // 解析済みコンテキストの復元(同一棋譜リロード最適化)
        let savedCtx: Record<number, ExplanationContext> | null = null;
        if (opts?.restoreCtx) {
          savedCtx = loadContextsFromStorage(hashPgn(pgn));
        }

        setGame(g);
        setIndex(0);
        setContexts(savedCtx ?? {});
        setExplanations({});
        setThreads({});
        setError(null);
        setLoadedPgn(pgn);
        // 全手解析キャンセル
        ++bulkTokenRef.current;
        setAnalyzeAllProgress(null);
        // 単手解析トークンもリセット
        ++analyzeToken.current;
      } catch (e) {
        setError(`PGN を読み込めませんでした: ${(e as Error).message}`);
        setGame(null);
        setLoadedPgn(null);
      }
    },
    [], // useState setters は安定 → deps 不要
  );

  // ── 起動時の初期ロード ──────────────────────────────────────
  /*
   * 優先順位:
   *   1. URL ハッシュ #g=<base64url> — 共有リンク
   *   2. localStorage セッション — 前回の棋譜
   *   3. SAMPLE_PGN — 初回訪問(空っぽで迎えない)
   *
   * WHY ここで loadPgn を呼ぶか:
   *   handleLoad は pgnText state を読む(React のスナップショット)ため、
   *   setPgnText 直後に呼んでも新しい値を見られない。
   *   loadPgn は直接 pgn 文字列を引数に取るため、状態更新と同時に呼べる。
   */
  useEffect(() => {
    // 0. 対局からの振り返り(initialPgn)。最優先。
    //    PlayView が指した対局をそのまま解析できるよう、他の復元より先に読む。
    if (initialPgn) {
      setPgnText(initialPgn);
      loadPgn(initialPgn, { restoreCtx: true });
      return;
    }

    // 1. URL ハッシュ
    const hashMatch = window.location.hash.match(/[#&]g=([A-Za-z0-9\-_]*)/);
    if (hashMatch?.[1]) {
      const decoded = decodePgnFromUrl(hashMatch[1]);
      if (decoded) {
        setPgnText(decoded);
        loadPgn(decoded);
        return;
      }
    }

    // 2. localStorage セッション
    const session = loadSessionFromStorage();
    if (session) {
      setPgnText(session.pgn);
      setLevel(session.level);
      setOrientation(session.orientation);
      setHintDismissed(session.hintDismissed);
      loadPgn(session.pgn, { restoreCtx: true });
      return;
    }

    // 3. サンプル自動ロード(初回訪問 → 空画面でなく対局が見える状態で出迎える)
    loadPgn(SAMPLE_PGN);
    // pgnText の初期値は SAMPLE_PGN なので setPgnText は不要
  }, [loadPgn, initialPgn]); // loadPgn は安定。initialPgn はマウント毎固定(App が key で再マウント)

  // ── セッション永続化 ────────────────────────────────────────
  // loadedPgn・level・orientation・hintDismissed が変わるたびに保存。
  // loadedPgn が null のとき(ロード失敗)は保存しない。
  useEffect(() => {
    if (!loadedPgn) return;
    saveSessionToStorage({ pgn: loadedPgn, level, orientation, hintDismissed });
  }, [loadedPgn, level, orientation, hintDismissed]);

  // ── 解析コンテキスト永続化 ─────────────────────────────────
  // contexts が変わるたびに PGN ハッシュキーで保存。
  // 全手解析中も逐次保存し、途中で閉じても再開時に復元できる。
  // QuotaExceeded は saveContextsToStorage 内で握られる。
  useEffect(() => {
    if (!loadedPgn || Object.keys(contexts).length === 0) return;
    saveContextsToStorage(hashPgn(loadedPgn), contexts);
  }, [loadedPgn, contexts]);

  // ── 棋譜読み込み(ボタン押下) ────────────────────────────────
  const handleLoad = useCallback(() => {
    // ボタン経由ロードはコンテキスト復元あり(同一棋譜リロードを最適化)
    loadPgn(pgnText, { restoreCtx: true });
  }, [pgnText, loadPgn]);

  const profile: KnowledgeProfile = useMemo(() => ({ known: [], unknown: [], level }), [level]);

  // ── 単手解析(ナビゲートするたびに現在手を解析) ───────────────
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !game || index < 1) return;
    const ply = index - 1;
    if (contexts[ply]) return; // 既にキャッシュ済み

    const token = ++analyzeToken.current;
    const move = game.moves[ply];
    (async () => {
      const before = await engine.analyze(move.fenBefore, { multipv: 3, depth: 12 });
      const after = await engine.analyze(move.fenAfter, { multipv: 1, depth: 12 });
      if (token !== analyzeToken.current) return; // 古い解析は破棄
      const best = before.lines[0];
      if (!best) return;
      const ctx = buildExplanationContext({
        fenBefore: move.fenBefore,
        movePlayed: move.uci,
        bestScore: best.score,
        bestMove: before.bestMove ?? best.moves[0],
        pv: best.moves,
        scoreAfter: after.lines[0]?.score ?? { type: 'cp', value: 0 },
      });
      setContexts((prev) => ({ ...prev, [ply]: ctx }));
    })();
  }, [index, game, contexts]);

  // ── 全手解析 ─────────────────────────────────────────────────
  /*
   * handleAnalyzeAll:
   *   全 ply を順次エンジン解析して contexts を埋める。
   *   速度のため depth=10/multipv=2 と浅め(単手は depth=12/multipv=3 を維持)。
   *   await の間に setTimeout(0) を挟んで UI のブロックを防ぐ。
   *
   * キャンセル条件:
   *   - 棋譜再読み込み(loadPgn が bulkTokenRef を更新)
   *   - コンポーネントアンマウント(エンジン cleanup が bulkTokenRef を更新)
   *   - 二重起動は isAnalyzingAllRef でガード(analyzeAllProgress の state 更新前に
   *     同じ関数が呼ばれる可能性があるため ref を使う)
   */
  const handleAnalyzeAll = useCallback(async () => {
    const engine = engineRef.current;
    if (!game || !engine || isAnalyzingAllRef.current) return;

    isAnalyzingAllRef.current = true;
    // 自分のトークンを取得(以降 bulkTokenRef が変われば中断)
    const myToken = ++bulkTokenRef.current;
    const total = game.length;
    setAnalyzeAllProgress({ done: 0, total });

    let done = 0;
    for (let ply = 0; ply < total; ply++) {
      // キャンセルチェック
      if (bulkTokenRef.current !== myToken) break;

      const move = game.moves[ply];
      const currentEngine = engineRef.current;
      if (!currentEngine) break;

      try {
        // 既に解析済みの ply はスキップ(functional update でレース回避)
        // ただし setContexts は非同期で確認できないため、ここでは二度解析になっても
        // functional update 内で上書きしないことで冪等を保つ
        const before = await currentEngine.analyze(move.fenBefore, { multipv: 2, depth: 10 });
        if (bulkTokenRef.current !== myToken) break;

        const after = await currentEngine.analyze(move.fenAfter, { multipv: 1, depth: 10 });
        if (bulkTokenRef.current !== myToken) break;

        const best = before.lines[0];
        if (best) {
          const ctx = buildExplanationContext({
            fenBefore: move.fenBefore,
            movePlayed: move.uci,
            bestScore: best.score,
            bestMove: before.bestMove ?? best.moves[0],
            pv: best.moves,
            scoreAfter: after.lines[0]?.score ?? { type: 'cp', value: 0 },
          });
          // 既に別手段で解析済みの場合は上書きしない
          setContexts((prev) => (ply in prev ? prev : { ...prev, [ply]: ctx }));
        }
      } catch {
        // エンジンエラー(Worker 終了等)は無視して次の手へ
      }

      done++;
      if (bulkTokenRef.current === myToken) {
        setAnalyzeAllProgress({ done, total });
      }

      // ブラウザに制御を返してUIフリーズを防ぐ(1フレーム yield)
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    isAnalyzingAllRef.current = false;
    // トークンが一致している(= 外からキャンセルされていない)なら進捗をクリア
    if (bulkTokenRef.current === myToken) {
      setAnalyzeAllProgress(null);
    }
  }, [game]); // game のみ。engine は ref 経由、setContexts は安定した setter

  // ── キーボードナビゲーション ─────────────────────────────────
  /*
   * ←/→ で前後1手、Home/End で先頭/末尾に移動。
   * input/textarea へのフォーカス中はハイジャックしない。
   * game が変わるたびにリスナーを貼り直す(クロージャで game.length を参照)。
   */
  useEffect(() => {
    // active=false(非表示=対局タブ表示中)ではリスナーを張らない。
    // → 対局中に Home/End/矢印を裏の ReviewView が横取りする回帰を防ぐ。
    if (!game || !active) return;
    const handler = (e: KeyboardEvent) => {
      // テキスト入力中は無視
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      // details の summary をスペースで開閉する動作とも干渉しない

      switch (e.key) {
        case 'ArrowLeft':
          setIndex((i) => Math.max(0, i - 1));
          e.preventDefault();
          break;
        case 'ArrowRight':
          setIndex((i) => Math.min(game.length, i + 1));
          e.preventDefault();
          break;
        case 'Home':
          setIndex(0);
          e.preventDefault();
          break;
        case 'End':
          setIndex(game.length);
          e.preventDefault();
          break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [game, active]);

  // ── 各種計算 ─────────────────────────────────────────────────

  const currentPly = index - 1;
  const currentContext = index >= 1 ? (contexts[currentPly] ?? null) : null;

  /*
   * 評価バー用: 白視点センチポーン
   *
   * buildExplanationContext では:
   *   evalAfter = negateScore(scoreAfter) のセンチポーン換算値
   *   = 「手を指したプレイヤー(手番)視点」の、指した後の評価値
   *
   * 白が指した後: evalAfter > 0 = 白有利 → そのまま使う
   * 黒が指した後: evalAfter > 0 = 黒有利 → 符号を反転して白視点に
   */
  const lastMoveColor =
    game && currentPly >= 0 && currentPly < game.moves.length
      ? game.moves[currentPly].color
      : undefined;
  const evalCpWhite =
    currentContext?.evalAfter !== undefined && lastMoveColor !== undefined
      ? lastMoveColor === 'w'
        ? currentContext.evalAfter
        : -currentContext.evalAfter
      : undefined;

  // 手の質マップ(MoveList に渡す)
  const qualities: Record<number, MoveQuality | undefined> = {};
  for (const [k, v] of Object.entries(contexts)) qualities[Number(k)] = v.quality;

  // 精度サマリ計算(解析済みコンテキストが変わるたびに再計算)
  const accuracySummary = useMemo(
    () => (game ? computeAccuracySummary(contexts, game.moves) : null),
    [contexts, game],
  );

  const fen = game ? game.fenAt(index) : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const lastMoveUci = game && index >= 1 ? game.moves[index - 1].uci : null;
  const max = game?.length ?? 0;

  // ── 解説コールバック ─────────────────────────────────────────

  const onExplain = useCallback(async () => {
    if (!currentContext) return;
    setBusy(true);
    try {
      const text = await requestExplanation({
        mode: 'explain',
        game: 'chess',
        context: currentContext,
        profile,
      });
      setExplanations((prev) => ({ ...prev, [currentPly]: text }));
    } catch (e) {
      setExplanations((prev) => ({
        ...prev,
        [currentPly]: `解説の取得に失敗: ${(e as Error).message}`,
      }));
    } finally {
      setBusy(false);
    }
  }, [currentContext, currentPly, profile]);

  // onExplain の最新版を常に ref に同期(自動解説の stale closure 対策)
  onExplainRef.current = onExplain;

  const onAsk = useCallback(
    async (question: string) => {
      if (!currentContext) return;
      const prevThread = threads[currentPly] ?? [];
      setThreads((p) => ({
        ...p,
        [currentPly]: [...prevThread, { role: 'user', content: question }],
      }));
      setBusy(true);
      try {
        const text = await requestExplanation({
          mode: 'followup',
          game: 'chess',
          context: currentContext,
          question,
          history: prevThread,
          profile,
        });
        setThreads((p) => ({
          ...p,
          [currentPly]: [...(p[currentPly] ?? []), { role: 'assistant', content: text }],
        }));
      } catch (e) {
        // WHY catch を足したか(実運用で発覚): 以前は catch 無しで、Gemini の一時 503 等で
        // 追問が失敗すると未処理 rejection になり、ユーザーには「質問が黙って消えた」ように
        // 見えていた。エラーもスレッドに吹き出しとして残し、もう一度聞き直せると分からせる。
        setThreads((p) => ({
          ...p,
          [currentPly]: [
            ...(p[currentPly] ?? []),
            {
              role: 'assistant',
              content: `（応答を取得できませんでした: ${(e as Error).message}。少し待ってからもう一度質問してください）`,
            },
          ],
        }));
      } finally {
        setBusy(false);
      }
    },
    [currentContext, currentPly, threads, profile],
  );

  // ── 自動解説(デバウンス ~500ms) ─────────────────────────────
  /*
   * 設計:
   *   index が変わる(手を進める)たびに 500ms タイマーをセット。
   *   タイマー発火時に "解析済み context あり かつ 解説なし" を確認してから
   *   onExplain を呼ぶ。全手解析中(analyzeAllProgress !== null)は発火させない。
   *
   * WHY ref を使って最新値を読むか:
   *   effect 内の setTimeout コールバックは effect 実行時のクロージャを参照するため
   *   contexts・explanations・busy・onExplain が古い値になる。
   *   ref に render ごと最新値を同期することでこの問題を回避する。
   *
   * WHY deps が [index, autoExplain, analyzeAllProgress] だけか:
   *   "手を進めたとき" だけに反応したい。contexts や explanations が変わっても
   *   (全手解析中など)発火させないのが仕様。index と toggle と解析中フラグだけで十分。
   */
  useEffect(() => {
    if (!autoExplain || analyzeAllProgress !== null) return;
    if (index < 1) return;

    const id = window.setTimeout(() => {
      const ply = index - 1;
      // ✅ ref 経由で最新の状態を参照 → stale closure 問題なし
      if (!contextsRef.current[ply]) return; // 未解析
      if (explanationsRef.current[ply] !== undefined) return; // 既解説済み
      if (busyRef.current) return; // 別のリクエスト実行中
      onExplainRef.current?.();
    }, 500);

    return () => window.clearTimeout(id);
  }, [index, autoExplain, analyzeAllProgress]);
  // ^ 意図的に contexts/explanations/busy/onExplain を除外。
  //   "ナビ後のデバウンス" のみ発火させたいため。最新値は ref 経由で参照。
  //   ref.current へのアクセスは ESLint の exhaustive-deps チェック外のため警告なし。

  // ── 共有URL ──────────────────────────────────────────────────
  /*
   * loadedPgn が SHARE_MAX_PGN_CHARS 以下なら URL ハッシュ付き共有URLを生成。
   * 超過時は null → ボタン無効化 + 注記。
   *
   * WHY base64url か:
   *   PGN はスペース・改行・特殊記号を含むため生のままではURLに使えない。
   *   base64url はパディングなし・URL-safe で最も簡潔。
   */
  const shareUrl = useMemo(() => {
    if (!loadedPgn || loadedPgn.length > SHARE_MAX_PGN_CHARS) return null;
    const encoded = encodePgnForUrl(loadedPgn);
    const url = new URL(window.location.href);
    url.hash = `g=${encoded}`;
    // 余分な query や hash を消して最小化
    return url.toString();
  }, [loadedPgn]);

  const handleShareCopy = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // clipboard API 未対応(古いブラウザ / 非 HTTPS)は無視
    }
  }, [shareUrl]);

  // ── JSX ──────────────────────────────────────────────────────

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      {/* ── 使い方ヒントバナー(初回訪問 or ヒント未閉じ) ────────
          game がロード済みのとき表示(自動ロード後に表示されるため空画面は避けられる)。
          閉じた状態は localStorage セッションに保存される。                     */}
      {!hintDismissed && game && (
        <div
          role="note"
          aria-label="使い方ヒント"
          className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-ai-bg px-4 py-2.5 dark:bg-ai-deep"
        >
          <span className="flex-1 text-xs text-ai dark:text-ai-muted">
            ← / → キーで手を送り、「全手を解析」で採点、手をクリックで解説します
          </span>
          <button
            type="button"
            aria-label="ヒントを閉じる"
            onClick={() => setHintDismissed(true)}
            className="focus-ai shrink-0 rounded px-2 py-0.5 text-xs text-ai opacity-60 transition-opacity hover:opacity-100 dark:text-ai-muted"
          >
            閉じる
          </button>
        </div>
      )}

      {/* ── ツールバー(エンジン状態 + レベル切替) ── */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle">
          {engineKind === 'loading'
            ? '読み込み中…'
            : engineKind === 'stockfish'
              ? 'Stockfish WASM'
              : 'モック評価'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-xs text-muted">レベル</span>
          {LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => setLevel(lv!)}
              className={[
                'focus-ai min-h-11 rounded px-2.5 text-xs font-medium transition-colors',
                level === lv
                  ? 'bg-ai text-white dark:bg-ai-dim'
                  : 'text-muted hover:bg-surface-2 hover:text-on-surface',
              ].join(' ')}
            >
              {LEVEL_LABEL[lv!]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── 盤 + 評価バー + ナビ + 評価グラフ ── */}
        <section className="flex flex-col gap-4">
          {/* 評価バー(左) + 盤(右) */}
          <div className="mx-auto flex w-full max-w-[500px] items-stretch gap-2">
            <div className="w-3 flex-none">
              <EvalBar evalCp={evalCpWhite} />
            </div>
            <div className="min-w-0 flex-1">
              {/* orientation を state で制御 → 盤反転ボタンと連動 */}
              <Board fen={fen} lastMoveUci={lastMoveUci} orientation={orientation} />
            </div>
          </div>

          {/* ナビゲーションボタン + 盤反転ボタン
              WHY 44px (min-h-11): WCAG 2.5.5 / Apple HIG のタップ領域要件。
              棋譜ナビは連続操作が多くスマホでの誤タップを減らすため大きくする。 */}
          <div className="flex items-center justify-center gap-1.5">
            <NavButton
              label="⏮"
              ariaLabel="先頭へ"
              onClick={() => setIndex(0)}
              disabled={!game || index === 0}
            />
            <NavButton
              label="◀"
              ariaLabel="1手戻る（←キーでも操作可）"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={!game || index === 0}
            />
            <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-muted">
              {index} / {max}
            </span>
            <NavButton
              label="▶"
              ariaLabel="1手進む（→キーでも操作可）"
              onClick={() => setIndex((i) => Math.min(max, i + 1))}
              disabled={!game || index === max}
            />
            <NavButton
              label="⏭"
              ariaLabel="末尾へ"
              onClick={() => setIndex(max)}
              disabled={!game || index === max}
            />
            {/* 盤反転ボタン
                WHY 同じ行に置くか: ナビとセットで使うことが多く、
                別行に置くよりユーザーが探しやすい。 */}
            <button
              type="button"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
              aria-label={`盤を反転（現在: ${orientation === 'white' ? '白目線' : '黒目線'}）`}
              title="盤を反転"
              disabled={!game}
              className="focus-ai ml-1 min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface-2 disabled:opacity-30"
            >
              ⇅
            </button>
            {/* この局面から対局(Phase 2B・④「復習で再開」の実装)
                現在表示中の局面 FEN を PlayView へ渡してカジュアル対局を開始する。
                「悪手の場面から自分ならどう指すか試す」という復習ループの核。 */}
            {onPlayFrom && (
              <button
                type="button"
                onClick={() => game && onPlayFrom(game.fenAt(index))}
                disabled={!game}
                title="表示中の局面から AI と対局（カジュアル・あなたは手番側）"
                className="focus-ai ml-1 min-h-11 rounded-lg border border-ai px-3 text-sm font-medium text-ai transition-colors hover:bg-ai-bg disabled:opacity-30 dark:border-ai-muted dark:text-ai-muted dark:hover:bg-ai-deep"
              >
                ▶ この局面から対局
              </button>
            )}
          </div>

          {/* 評価グラフ
              解析済みデータが増えるにつれてリアルタイムで更新される。
              クリックでその手へジャンプ。 */}
          {game && (
            <div className="mx-auto w-full max-w-[500px] rounded-lg border border-border bg-surface-2 p-2 shadow-card">
              <EvalGraph
                moves={game.moves}
                contexts={contexts}
                currentIndex={index}
                onSeek={setIndex}
              />
            </div>
          )}
        </section>

        {/* ── サイドパネル: PGN読み込み + 解析 + 手順表 + 解説 ── */}
        <aside className="flex flex-col gap-4">
          {/* PGN 読み込みセクション */}
          <details
            open
            className="group rounded-xl border border-border bg-surface-2 p-4 shadow-card"
          >
            <summary className="focus-ai -m-1 cursor-pointer rounded p-1 text-sm font-semibold text-on-surface">
              棋譜を読み込む（PGN）
            </summary>

            <div className="mt-3 flex flex-col gap-3">
              {/* サンプル対局クイックロード
                  テキストエリアを埋めるだけ。読み込みは「読み込む」ボタンで確定。 */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-subtle">サンプル</span>
                {SAMPLE_GAMES.map(({ label, pgn }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setPgnText(pgn)}
                    className="focus-ai rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-ai hover:text-ai"
                  >
                    {label}
                  </button>
                ))}
              </div>

              <textarea
                value={pgnText}
                onChange={(e) => setPgnText(e.target.value)}
                rows={5}
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-xs text-on-surface placeholder:text-subtle focus:border-ai focus:outline-none"
              />

              <div className="flex flex-wrap items-center gap-2">
                {/* 読み込みボタン */}
                <button
                  type="button"
                  onClick={handleLoad}
                  className="focus-ai rounded-lg bg-ai px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ai-hover dark:bg-ai-dim dark:hover:bg-ai"
                >
                  読み込む
                </button>

                {/* .pgn ファイルアップロード
                    label でクリック領域を広げ、実 input は sr-only で非表示。
                    WHY label: ファイル選択 UI はブラウザ実装依存のため、
                    カスタムボタンに見せるには label で包む手法が最も互換性が高い。 */}
                <label className="focus-ai cursor-pointer rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:border-ai hover:text-ai">
                  PGN ファイル
                  <input
                    type="file"
                    accept=".pgn,text/plain"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => setPgnText((ev.target?.result as string) ?? '');
                      reader.readAsText(file);
                      // 同じファイルを再度選択できるよう value をリセット
                      e.target.value = '';
                    }}
                  />
                </label>

                {error && (
                  <p className="text-xs text-[var(--q-miss-fg)]" role="alert">
                    {error}
                  </p>
                )}
              </div>

              {/* 共有リンク ─────────────────────────────────────────
                  loadedPgn がある場合のみ表示。SHARE_MAX_PGN_CHARS を超える棋譜は
                  ボタンを無効化し注記を表示(コピーすると URL が壊れる可能性を排除)。
                  WHY URL ハッシュか: クエリパラメータと違い、ハッシュはサーバーに
                  送信されないためバックエンド側の処理が不要。SPA 向きの方式。   */}
              {loadedPgn && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                  <button
                    type="button"
                    onClick={handleShareCopy}
                    disabled={!shareUrl}
                    title={
                      !shareUrl
                        ? `棋譜が ${SHARE_MAX_PGN_CHARS} 文字を超えているため共有できません`
                        : '現在の棋譜の共有リンクをクリップボードにコピー'
                    }
                    className="focus-ai rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-ai hover:text-ai disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {shareCopied ? 'コピーしました！' : '共有リンクをコピー'}
                  </button>
                  {!shareUrl && (
                    <span className="text-[10px] text-subtle">
                      棋譜が長すぎます（上限 {SHARE_MAX_PGN_CHARS} 文字）
                    </span>
                  )}
                </div>
              )}
            </div>
          </details>

          {/* 全手解析セクション(ゲーム読み込み後のみ表示) */}
          {game && (
            <div className="rounded-xl border border-border bg-surface-2 p-4 shadow-card">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-on-surface">全手解析</h2>
                  <p className="mt-0.5 text-xs text-muted">
                    全{game.length}手をエンジンで一括解析します
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAnalyzeAll}
                  disabled={analyzeAllProgress !== null || engineKind === 'loading'}
                  className="focus-ai shrink-0 rounded-lg border border-ai px-3 py-2 text-sm font-medium text-ai transition-colors hover:bg-ai-bg disabled:cursor-not-allowed disabled:opacity-50 dark:border-ai-muted dark:text-ai-muted dark:hover:bg-ai-deep"
                >
                  {analyzeAllProgress !== null ? '解析中…' : '全手を解析'}
                </button>
              </div>

              {/* 解析進捗バー */}
              {analyzeAllProgress !== null && (
                <div className="mt-3" role="status" aria-live="polite">
                  <div className="mb-1 flex justify-between text-[10px] tabular-nums text-muted">
                    <span>解析中</span>
                    <span>
                      {analyzeAllProgress.done} / {analyzeAllProgress.total}
                    </span>
                  </div>
                  {/* プログレスバー: aria-* で進捗を AT に伝える */}
                  <div
                    role="progressbar"
                    aria-valuenow={analyzeAllProgress.done}
                    aria-valuemin={0}
                    aria-valuemax={analyzeAllProgress.total}
                    aria-label={`解析進捗 ${analyzeAllProgress.done}/${analyzeAllProgress.total}手`}
                    className="h-1.5 overflow-hidden rounded-full bg-border"
                  >
                    <div
                      className="h-full bg-ai duration-300 motion-safe:transition-all dark:bg-ai-muted"
                      style={{
                        width: `${(analyzeAllProgress.done / analyzeAllProgress.total) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* 自動解説トグル ─────────────────────────────────────
                  既定 OFF: 毎手ごとに解説 API を呼ぶとコストが暴発するため。
                  ユーザーが意識して ON にした場合のみ発火させる。
                  全手解析中は発火させない(analyzeAllProgress !== null で抑制)。 */}
              <div className="mt-3 border-t border-border pt-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={autoExplain}
                    onChange={(e) => setAutoExplain(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-ai)]"
                    aria-label="手を進めたら自動で解説する（解析済みの手のみ・約500ms後に発火）"
                  />
                  手を進めたら自動解説
                  <span className="text-subtle">（解析済みの手のみ・既定 OFF）</span>
                </label>
              </div>
            </div>
          )}

          {/* 手順表
              contexts を渡して解析済み手に評価値を表示。
              currentIndex が変わると自動スクロール(MoveList 内で制御)。 */}
          {game && (
            <MoveList
              moves={game.moves}
              currentIndex={index}
              qualities={qualities}
              contexts={contexts}
              onSelect={setIndex}
            />
          )}

          {/* 精度サマリ(1手以上解析済みのとき表示) */}
          {game && accuracySummary && (
            <AccuracySummary summary={accuracySummary} totalMoves={game.length} />
          )}

          {/* 解説パネル */}
          <div className="rounded-xl border border-border bg-surface-2 p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold text-on-surface">解説・対話</h2>
            <ExplanationPanel
              context={currentContext}
              explanation={index >= 1 ? (explanations[currentPly] ?? null) : null}
              thread={index >= 1 ? (threads[currentPly] ?? []) : []}
              busy={busy}
              onExplain={onExplain}
              onAsk={onAsk}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

/*
 * NavButton — ナビゲーションボタン
 *
 * ariaLabel を追加: label が「◀」のような記号のみの場合、スクリーンリーダーが
 * 意味を読み上げられないため aria-label で補完する。
 * min-h-11: 44px タップ領域確保(WCAG 2.5.5 / Apple HIG)。
 */
function NavButton({
  label,
  ariaLabel,
  onClick,
  disabled,
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="focus-ai min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm text-on-surface shadow-card transition-colors hover:bg-surface-2 hover:shadow-none disabled:opacity-30 disabled:shadow-none"
    >
      {label}
    </button>
  );
}
