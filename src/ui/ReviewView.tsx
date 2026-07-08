import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessGame } from '../core/game';
import { chessGameModel, gameMoveRecords, type GameModel } from '../core/gameModel';
import { buildExplanationContext } from '../core/classify';
import { computeAccuracySummary } from '../core/evalUtils';
import type { ExplanationContext, GameKind, KnowledgeProfile, MoveQuality } from '../core/types';
import type { ChessEngine } from '../engine/types';
import {
  createEngine,
  createShogiEngine,
  type EngineKind,
  type ShogiEngineKind,
} from '../engine/factory';
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

/*
 * ShogiBoard は将棋タブを開いたときだけ読み込む（React.lazy で code-split）。
 * WHY: shogiground/tsshogi/やねうら王 をチェス利用者のメインバンドルに 1 バイトも載せない不変条件。
 *   static import すると shogiground がメインチャンクに漏れるため、必ず動的 import 経由にする。
 */
const ShogiBoard = lazy(() => import('./ShogiBoard').then((m) => ({ default: m.ShogiBoard })));

/** 盤の既定局面（棋譜ロード前の空表示用）。chess=FEN / shogi=SFEN。 */
const DEFAULT_CHESS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const DEFAULT_SHOGI_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

/*
 * 将棋モードのサンプル棋譜（KIF）。チェスの SAMPLE_PGN と同じく「初回に空画面で迎えない」ため。
 * 角換わりの出だし4手（Phase 4-0 スパイクで tsshogi パース PASS を確認した局面系）。
 */
const SAMPLE_KIF = [
  '手合割：平手',
  '先手：先手',
  '後手：後手',
  '手数----指手---------消費時間--',
  '   1 ７六歩(77)',
  '   2 ３四歩(33)',
  '   3 ２二角成(88)',
  '   4 同銀(31)',
].join('\n');

/** crossOriginIsolated（=SharedArrayBuffer 有効）か。Safari(credentialless 非対応)では false。 */
const COI_ENABLED = typeof window !== 'undefined' && window.crossOriginIsolated === true;
/** テスト/開発でモックエンジンを明示選択しているか。 */
const MOCK_ENGINE_ENV = (import.meta.env.VITE_ENGINE as string | undefined) === 'mock';
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
 * @param initialRecord 対局(PlayView)からの「振り返る」で渡される棋譜（kind + 本文。chess=PGN / shogi=KIF）。
 *   指定時は URL ハッシュ・セッション・サンプルより優先してこの棋譜をロードする（Codex 修正 #2）。
 *   App は振り返りのたびに key を変えて ReviewView を再マウントするため、この prop は
 *   マウント毎に固定値になる(=マウント時初期化ロジックだけで正しく反映される)。
 * @param active このビューが現在表示中か(既定 true)。
 *   WHY 必要か: App は「一度開いたら以降 unmount せず hidden で保持」する(対局中の状態を守るため)。
 *   その結果、対局タブに戻っても ReviewView は生き続ける。可視判定なしだと、非表示中でも
 *   document レベルの keydown(←/→/Home/End)を横取りして対局のキー操作やページスクロールを
 *   潰してしまう(reviewer 指摘の回帰)。active=false のときはグローバルリスナーを張らない。
 */
export function ReviewView({
  initialRecord,
  active = true,
  onPlayFrom,
}: {
  initialRecord?: { kind: GameKind; text: string };
  active?: boolean;
  /**
   * 「この局面から対局」(Phase 2B)。現在表示中の局面 FEN を対局画面へ引き渡す。
   * 未指定なら導線ボタン自体を出さない(単体利用やテストで PlayView が無い構成を壊さない)。
   */
  onPlayFrom?: (fen: string) => void;
} = {}) {
  // chess の PGN 初期値。将棋レコードのときはサンプル PGN のまま（将棋本文は shogiText へ）。
  const [pgnText, setPgnText] = useState(
    initialRecord?.kind === 'chess' ? initialRecord.text : SAMPLE_PGN,
  );
  // model は GameModel（chess/shogi 共通の薄い読み取り面）。UI・解析ループはこれ経由で動く。
  const [model, setModel] = useState<GameModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // engineKind は chess(stockfish/mock) と shogi(yaneuraou/mock) と特別状態(loading/unsupported)の合併。
  const [engineKind, setEngineKind] = useState<
    EngineKind | ShogiEngineKind | 'loading' | 'unsupported'
  >('loading');
  const [busy, setBusy] = useState(false);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');

  // ── 将棋モード関連 ──────────────────────────────────────────
  // kind: 現在のゲーム種別（既定 chess＝チェス利用者の体験を一切変えない）。
  // 対局からの将棋振り返り(initialRecord.kind==='shogi')のときだけ初手から shogi でマウントする。
  const [kind, setKind] = useState<GameKind>(initialRecord?.kind ?? 'chess');
  // 将棋の棋譜入力（KIF/CSA/SFEN 等）。チェスの pgnText と分離して chess 経路を汚さない。
  const [shogiText, setShogiText] = useState(
    initialRecord?.kind === 'shogi' ? initialRecord.text : SAMPLE_KIF,
  );
  // 将棋棋譜パース中フラグ（tsshogi の動的 import 待ち）。
  const [shogiLoading, setShogiLoading] = useState(false);

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

  // ── エンジン初期化（kind に追従） ──────────────────────────────
  // WHY kind 依存にするか:
  //   チェスは Stockfish、将棋はやねうら王(WASM)と別エンジン。タブ(kind)を切り替えたら
  //   対応するエンジンへ差し替える。エンジンは 1 種だけ生かして worker を無駄に増やさない。
  //
  // WHY 将棋 + coi 無効を特別扱いするか（Codex ゲート① (b)・Safari 非対称の許容）:
  //   やねうら王は SharedArrayBuffer 必須で、credentialless 非対応の Safari では動かない。
  //   その環境ではエンジンを起動せず 'unsupported' にして「盤の閲覧のみ可」に倒す（解析なしでも
  //   盤ナビゲーションは動く）。チェスは lite-single で SAB 不要なので Safari でも従来どおり動く。
  useEffect(() => {
    let disposed = false;

    if (kind === 'shogi' && !COI_ENABLED && !MOCK_ENGINE_ENV) {
      // 将棋エンジン非対応環境（Safari 等）。解析は諦め、盤閲覧・ナビだけ提供する。
      setEngineKind('unsupported');
      return;
    }

    setEngineKind('loading');
    const create = kind === 'shogi' ? createShogiEngine() : createEngine();
    create.then(({ engine, kind: ek }) => {
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      setEngineKind(ek);
    });
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [kind]);

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

        // ChessGame を GameModel に薄く包む（chessGameModel）。ChessGame 本体は無改修。
        setModel(chessGameModel(g));
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
        setModel(null);
        setLoadedPgn(null);
      }
    },
    [], // useState setters は安定 → deps 不要
  );

  // ── 将棋棋譜ロード ──────────────────────────────────────────
  /*
   * loadShogi — KIF/CSA/SFEN 等の文字列から将棋 GameModel を構築する。
   *
   * WHY 動的 import か（1バイト不変条件）:
   *   tsshogi は shogiGame.ts 経由でのみ読み込む。ここで `await import` することで、将棋棋譜を
   *   実際に読み込むまで tsshogi をチェス利用者に払わせない。
   *
   * WHY loadedPgn を null にするか（chess セッション/キャッシュの汚染防止）:
   *   セッション/コンテキスト永続化は loadedPgn（chess の PGN）をキーにしている。将棋の KIF を
   *   そこへ入れると、次回起動で chess として復元しようとして壊れる。MVP では将棋は永続化せず
   *   （再解析は許容）、loadedPgn=null にして両永続化 effect を確実にスキップさせる。
   */
  /*
   * ロード世代ガード(Codex ゲート②blocking #1):
   *   loadShogi は動的 import を await する間にユーザーがチェスへ戻れる。ガード無しだと
   *   「kind==='chess' なのに model.kind==='shogi'」が着弾し、チェス盤に SFEN が渡る・
   *   保存/共有/解説の状態が食い違う、という不整合が起きる。世代番号(seq)と現在 kind
   *   (kindRef)の両方を commit 直前に検査し、古いロード・対象外 kind の結果は黙って捨てる。
   */
  const shogiLoadSeqRef = useRef(0);
  const kindRef = useRef<GameKind>('chess'); // setKind と同時に手動更新(await 越しに最新 kind を読む)

  const loadShogi = useCallback(async (text: string) => {
    const seq = ++shogiLoadSeqRef.current;
    setShogiLoading(true);
    try {
      const { shogiGameModel } = await import('../core/shogiGame');
      const m = shogiGameModel(text);
      // race ガード: このロードが最新で、かつ今も将棋モードのときだけ commit する
      if (seq !== shogiLoadSeqRef.current || kindRef.current !== 'shogi') return;
      setModel(m);
      setIndex(0);
      setContexts({});
      setExplanations({});
      setThreads({});
      setError(null);
      setLoadedPgn(null); // 将棋は永続化しない（chess の復元を汚さない）
      ++bulkTokenRef.current;
      setAnalyzeAllProgress(null);
      ++analyzeToken.current;
    } catch (e) {
      if (seq !== shogiLoadSeqRef.current || kindRef.current !== 'shogi') return;
      setError(`将棋の棋譜を読み込めませんでした: ${(e as Error).message}`);
      setModel(null);
      setLoadedPgn(null);
    } finally {
      // ローディング表示は「最新のロード」だけが畳む(古いロードが新しい表示を消さない)
      if (seq === shogiLoadSeqRef.current) setShogiLoading(false);
    }
  }, []);

  // ── チェス/将棋 切替 ────────────────────────────────────────
  // 切替時に対応する棋譜を読み直す（チェスは pgnText、将棋は shogiText）。
  // WHY 明示トグルにするか（自動判別を採らない理由）:
  //   ①チェス利用者が誤って tsshogi を読み込む経路を作らない（1バイト不変条件を UI からも守る）
  //   ②KIF/PGN の自動判別は誤検出の余地があり、貼り付けたのに別ゲームで開く事故を避けられる。
  const switchKind = useCallback(
    (k: GameKind) => {
      if (k === kind) return;
      kindRef.current = k; // loadShogi の race ガードが await 越しに読む(state 更新は非同期のため)
      setKind(k);
      setIndex(0);
      if (k === 'shogi') {
        void loadShogi(shogiText);
      } else {
        loadPgn(pgnText, { restoreCtx: true });
      }
    },
    [kind, shogiText, pgnText, loadShogi, loadPgn],
  );

  // ── GameModel → MoveRecord[] 派生 ───────────────────────────
  // 既存 UI(MoveList/EvalGraph/computeAccuracySummary)と解析ループは MoveRecord[] を前提にしている。
  // GameModel から機械的に再構築する（gameMoveRecords）。チェスでは ChessGame.moves と完全一致するため
  // 既存挙動は不変（gameModel.ts の同値性コメント参照）。将棋は SFEN/USI/日本語ラベルがここに載る。
  const moveRecords = useMemo(() => (model ? gameMoveRecords(model) : []), [model]);

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
    // 0. 対局からの振り返り(initialRecord)。最優先。
    //    PlayView が指した対局をそのまま解析できるよう、他の復元より先に読む。
    if (initialRecord) {
      if (initialRecord.kind === 'shogi') {
        // WHY kindRef を setKind より先に同期で立てるか（Codex 修正 #2・4-1 の race ガードと整合）:
        //   loadShogi は tsshogi の動的 import を await する間、commit 直前に kindRef.current!=='shogi'
        //   だと結果を黙って捨てる（世代ガード）。setKind の反映は非同期なので、await 越しに最新 kind を
        //   読む kindRef を先に 'shogi' へ倒しておかないと、対局からの将棋振り返りが commit されず空になる。
        kindRef.current = 'shogi';
        setKind('shogi');
        setShogiText(initialRecord.text);
        void loadShogi(initialRecord.text);
      } else {
        kindRef.current = 'chess';
        setKind('chess');
        setPgnText(initialRecord.text);
        loadPgn(initialRecord.text, { restoreCtx: true });
      }
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
    // loadPgn/loadShogi は安定。initialRecord はマウント毎固定(App が key で再マウント)。
  }, [loadPgn, loadShogi, initialRecord]);

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
    if (!engine || !model || index < 1) return;
    const ply = index - 1;
    if (contexts[ply]) return; // 既にキャッシュ済み

    const token = ++analyzeToken.current;
    const move = moveRecords[ply];
    if (!move) return;
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
        kind: model.kind, // 手の質分類の閾値を chess/shogi で切替
      });
      setContexts((prev) => ({ ...prev, [ply]: ctx }));
    })();
  }, [index, model, moveRecords, contexts]);

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
    if (!model || !engine || isAnalyzingAllRef.current) return;

    isAnalyzingAllRef.current = true;
    // 自分のトークンを取得(以降 bulkTokenRef が変われば中断)
    const myToken = ++bulkTokenRef.current;
    const total = moveRecords.length;
    setAnalyzeAllProgress({ done: 0, total });

    let done = 0;
    for (let ply = 0; ply < total; ply++) {
      // キャンセルチェック
      if (bulkTokenRef.current !== myToken) break;

      const move = moveRecords[ply];
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
            kind: model.kind, // 手の質分類の閾値を chess/shogi で切替
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
  }, [model, moveRecords]); // model/moveRecords。engine は ref 経由、setContexts は安定した setter

  // ── キーボードナビゲーション ─────────────────────────────────
  /*
   * ←/→ で前後1手、Home/End で先頭/末尾に移動。
   * input/textarea へのフォーカス中はハイジャックしない。
   * game が変わるたびにリスナーを貼り直す(クロージャで game.length を参照)。
   */
  useEffect(() => {
    // active=false(非表示=対局タブ表示中)ではリスナーを張らない。
    // → 対局中に Home/End/矢印を裏の ReviewView が横取りする回帰を防ぐ。
    if (!model || !active) return;
    const total = moveRecords.length;
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
          setIndex((i) => Math.min(total, i + 1));
          e.preventDefault();
          break;
        case 'Home':
          setIndex(0);
          e.preventDefault();
          break;
        case 'End':
          setIndex(total);
          e.preventDefault();
          break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [model, moveRecords, active]);

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
    model && currentPly >= 0 && currentPly < moveRecords.length
      ? moveRecords[currentPly].color
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
    () => (model ? computeAccuracySummary(contexts, moveRecords) : null),
    [contexts, model, moveRecords],
  );

  // 表示局面。model 未ロード時は kind に応じた既定局面（chess=FEN / shogi=SFEN）で空表示する。
  const fen = model
    ? model.fenAt(index)
    : kind === 'shogi'
      ? DEFAULT_SHOGI_SFEN
      : DEFAULT_CHESS_FEN;
  // 直前手（chess=UCI / shogi=USI。どちらも盤コンポーネントが座標として解釈する）。
  const lastMoveUci = model && index >= 1 ? moveRecords[index - 1].uci : null;
  const max = moveRecords.length;

  // ── 解説コールバック ─────────────────────────────────────────

  const onExplain = useCallback(async () => {
    if (!currentContext) return;
    setBusy(true);
    try {
      const text = await requestExplanation({
        mode: 'explain',
        game: model?.kind ?? 'chess',
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
  }, [currentContext, currentPly, profile, model]);

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
          game: model?.kind ?? 'chess',
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
    [currentContext, currentPly, threads, profile, model],
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
      {!hintDismissed && model && (
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

      {/* ── ツールバー(チェス/将棋 切替 + エンジン状態 + レベル切替) ── */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {/* チェス/将棋 切替（レビュータブ内のゲーム種別トグル）。
            aria-pressed のトグルボタンで App のモード切替と実装方針を揃える。 */}
        <div
          aria-label="ゲーム種別切替"
          className="flex rounded-lg border border-border bg-surface p-0.5"
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

        <span className="text-xs text-subtle">
          {engineKind === 'loading'
            ? '読み込み中…'
            : engineKind === 'stockfish'
              ? 'Stockfish WASM'
              : engineKind === 'yaneuraou'
                ? 'やねうら王 WASM'
                : engineKind === 'unsupported'
                  ? 'エンジン非対応（閲覧のみ）'
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

      {/* 将棋エンジン非対応の告知（Safari 等・coi=false）。盤の閲覧とナビは可能。 */}
      {kind === 'shogi' && engineKind === 'unsupported' && (
        <div
          role="note"
          className="mb-4 rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-xs text-muted"
        >
          お使いのブラウザは将棋エンジン解析に未対応です（盤面の閲覧は可能）。 Chrome / Edge など
          SharedArrayBuffer 対応ブラウザでは 1 手ごとの解析・採点が使えます。
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── 盤 + 評価バー + ナビ + 評価グラフ ── */}
        <section className="flex flex-col gap-4">
          {/* 評価バー(左) + 盤(右) */}
          <div className="mx-auto flex w-full max-w-[500px] items-stretch gap-2">
            <div className="w-3 flex-none">
              <EvalBar evalCp={evalCpWhite} />
            </div>
            <div className="min-w-0 flex-1">
              {/* orientation を state で制御 → 盤反転ボタンと連動。
                  将棋は shogiground(遅延ロード)、チェスは chessground。fen は kind で FEN/SFEN。 */}
              {kind === 'shogi' ? (
                <Suspense
                  fallback={
                    <div className="aspect-square w-full animate-pulse rounded bg-surface-2" />
                  }
                >
                  <ShogiBoard sfen={fen} lastMoveUsi={lastMoveUci} orientation={orientation} />
                </Suspense>
              ) : (
                <Board fen={fen} lastMoveUci={lastMoveUci} orientation={orientation} />
              )}
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
              disabled={!model || index === 0}
            />
            <NavButton
              label="◀"
              ariaLabel="1手戻る（←キーでも操作可）"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={!model || index === 0}
            />
            <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-muted">
              {index} / {max}
            </span>
            <NavButton
              label="▶"
              ariaLabel="1手進む（→キーでも操作可）"
              onClick={() => setIndex((i) => Math.min(max, i + 1))}
              disabled={!model || index === max}
            />
            <NavButton
              label="⏭"
              ariaLabel="末尾へ"
              onClick={() => setIndex(max)}
              disabled={!model || index === max}
            />
            {/* 盤反転ボタン
                WHY 同じ行に置くか: ナビとセットで使うことが多く、
                別行に置くよりユーザーが探しやすい。 */}
            <button
              type="button"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
              aria-label={`盤を反転（現在: ${orientation === 'white' ? '白目線' : '黒目線'}）`}
              title="盤を反転"
              disabled={!model}
              className="focus-ai ml-1 min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface-2 disabled:opacity-30"
            >
              ⇅
            </button>
            {/* この局面から対局(Phase 2B・④「復習で再開」の実装)
                現在表示中の局面 FEN を PlayView へ渡してカジュアル対局を開始する。
                「悪手の場面から自分ならどう指すか試す」という復習ループの核。
                WHY チェス限定か: PlayView(対局)は現状チェス専用。将棋の局面を渡しても対局できないので
                将棋モードでは導線ごと隠す（将棋の対局は Phase 4-2 で別途）。 */}
            {onPlayFrom && kind === 'chess' && (
              <button
                type="button"
                onClick={() => model && onPlayFrom(model.fenAt(index))}
                disabled={!model}
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
          {model && (
            <div className="mx-auto w-full max-w-[500px] rounded-lg border border-border bg-surface-2 p-2 shadow-card">
              <EvalGraph
                moves={moveRecords}
                contexts={contexts}
                currentIndex={index}
                onSeek={setIndex}
              />
            </div>
          )}
        </section>

        {/* ── サイドパネル: 棋譜読込 + 解析 + 手順表 + 解説 ── */}
        <aside className="flex flex-col gap-4">
          {/* PGN 読み込みセクション（チェス時のみ） */}
          {kind === 'chess' && (
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
          )}

          {/* 将棋棋譜 読み込みセクション（将棋時のみ・KIF/CSA/SFEN） */}
          {kind === 'shogi' && (
            <details
              open
              className="group rounded-xl border border-border bg-surface-2 p-4 shadow-card"
            >
              <summary className="focus-ai -m-1 cursor-pointer rounded p-1 text-sm font-semibold text-on-surface">
                棋譜を読み込む（KIF / CSA / SFEN）
              </summary>

              <div className="mt-3 flex flex-col gap-3">
                <textarea
                  value={shogiText}
                  onChange={(e) => setShogiText(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  aria-label="将棋の棋譜（KIF / CSA / SFEN）"
                  className="w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-xs text-on-surface placeholder:text-subtle focus:border-ai focus:outline-none"
                />

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void loadShogi(shogiText)}
                    disabled={shogiLoading}
                    className="focus-ai rounded-lg bg-ai px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ai-hover disabled:opacity-50 dark:bg-ai-dim dark:hover:bg-ai"
                  >
                    {shogiLoading ? '読み込み中…' : '読み込む'}
                  </button>

                  {/* .kif/.csa ファイルアップロード（PGN 版と同じ label 手法） */}
                  <label className="focus-ai cursor-pointer rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:border-ai hover:text-ai">
                    KIF/CSA ファイル
                    <input
                      type="file"
                      accept=".kif,.kifu,.ki2,.csa,text/plain"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (ev) => setShogiText((ev.target?.result as string) ?? '');
                        reader.readAsText(file);
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
              </div>
            </details>
          )}

          {/* 全手解析セクション(ゲーム読み込み後のみ表示) */}
          {model && (
            <div className="rounded-xl border border-border bg-surface-2 p-4 shadow-card">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-on-surface">全手解析</h2>
                  <p className="mt-0.5 text-xs text-muted">
                    全{moveRecords.length}手をエンジンで一括解析します
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAnalyzeAll}
                  disabled={
                    analyzeAllProgress !== null ||
                    engineKind === 'loading' ||
                    engineKind === 'unsupported' ||
                    // 0手モデル(SFEN 単体等)では解析対象が無く、進捗が 0/0 = NaN% になる
                    // (Codex ゲート② nice-to-have)。押せなくして構造的に防ぐ。
                    moveRecords.length === 0
                  }
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
          {model && (
            <MoveList
              moves={moveRecords}
              currentIndex={index}
              qualities={qualities}
              contexts={contexts}
              onSelect={setIndex}
            />
          )}

          {/* 精度サマリ(1手以上解析済みのとき表示) */}
          {model && accuracySummary && (
            <AccuracySummary summary={accuracySummary} totalMoves={moveRecords.length} />
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
