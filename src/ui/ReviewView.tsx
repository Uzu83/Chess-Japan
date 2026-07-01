import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessGame } from '../core/game';
import { buildExplanationContext } from '../core/classify';
import type { ExplanationContext, KnowledgeProfile, MoveQuality } from '../core/types';
import type { ChessEngine } from '../engine/types';
import { createEngine, type EngineKind } from '../engine/factory';
import { requestExplanation } from '../explain/client';
import { Board } from './Board';
import { EvalBar } from './EvalBar';
import { MoveList } from './MoveList';
import { ExplanationPanel, type ChatTurn } from './ExplanationPanel';
import { SAMPLE_PGN } from './sample';

const LEVELS: KnowledgeProfile['level'][] = ['beginner', 'intermediate', 'advanced'];
const LEVEL_LABEL: Record<NonNullable<KnowledgeProfile['level']>, string> = {
  beginner: '初心者',
  intermediate: '中級',
  advanced: '上級',
};

/*
 * ReviewView — 棋譜振り返り画面
 *
 * レイアウト:
 *   モバイル: 縦スタック(盤 → 解説パネル)
 *   lg+:      2カラム(盤 | 手順表・解説)
 *
 * EvalBar 追加:
 *   盤の左側に縦型評価バー。currentContext の evalAfter を白視点に変換して渡す。
 *   evalAfter は「手を指したプレイヤー視点」なので、黒が指した後は符号を反転して
 *   白視点に揃える。
 *
 *   WHY evalAfter を使うか: board が「index 手目指した後」の局面を表示するため、
 *   evalBefore(指す前)ではなく evalAfter(指した後)が現在局面と対応する。
 */
export function ReviewView() {
  const [pgnText, setPgnText] = useState(SAMPLE_PGN);
  const [game, setGame] = useState<ChessGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [engineKind, setEngineKind] = useState<EngineKind | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  const [contexts, setContexts] = useState<Record<number, ExplanationContext>>({});
  const [explanations, setExplanations] = useState<Record<number, string>>({});
  const [threads, setThreads] = useState<Record<number, ChatTurn[]>>({});
  const [level, setLevel] = useState<NonNullable<KnowledgeProfile['level']>>('beginner');

  const engineRef = useRef<ChessEngine | null>(null);
  const analyzeToken = useRef(0);

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

  const handleLoad = useCallback(() => {
    try {
      const g = ChessGame.fromPgn(pgnText);
      if (g.length === 0) throw new Error('手が見つかりません');
      setGame(g);
      setIndex(0);
      setContexts({});
      setExplanations({});
      setThreads({});
      setError(null);
    } catch (e) {
      setError(`PGN を読み込めませんでした: ${(e as Error).message}`);
      setGame(null);
    }
  }, [pgnText]);

  const profile: KnowledgeProfile = useMemo(() => ({ known: [], unknown: [], level }), [level]);

  // 現在の手(index-1)を解析してコンテキストを作る。
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !game || index < 1) return;
    const ply = index - 1;
    if (contexts[ply]) return;

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
      } finally {
        setBusy(false);
      }
    },
    [currentContext, currentPly, threads, profile],
  );

  const qualities: Record<number, MoveQuality | undefined> = {};
  for (const [k, v] of Object.entries(contexts)) qualities[Number(k)] = v.quality;

  const fen = game ? game.fenAt(index) : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const lastMoveUci = game && index >= 1 ? game.moves[index - 1].uci : null;
  const max = game?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      {/* ── ツールバー(エンジン状態 + レベル切替) ── */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {/* エンジン状態: 補足情報なので subtle 色で控えめに */}
        <span className="text-xs text-subtle">
          {engineKind === 'loading'
            ? '読み込み中…'
            : engineKind === 'stockfish'
              ? 'Stockfish WASM'
              : 'モック評価'}
        </span>

        {/* レベル切替: 藍アクセントでアクティブを示す */}
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-xs text-muted">レベル</span>
          {LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => setLevel(lv!)}
              /* 44px タップ領域確保: min-h-11 = 44px */
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
        {/* ── 盤 + 評価バー + ナビ ── */}
        <section className="flex flex-col gap-4">
          {/* 評価バー(左) + 盤(右) を横並び
              items-stretch で EvalBar が盤と同じ高さになる。 */}
          <div className="mx-auto flex w-full max-w-[500px] items-stretch gap-2">
            {/* EvalBar ラッパ: w-3(12px) 固定幅、盤の高さに self-stretch */}
            <div className="w-3 flex-none">
              <EvalBar evalCp={evalCpWhite} />
            </div>
            {/* 盤 */}
            <div className="min-w-0 flex-1">
              <Board fen={fen} lastMoveUci={lastMoveUci} />
            </div>
          </div>

          {/* ナビゲーションボタン
              WHY 大きなタップ領域: 棋譜ナビは連続操作が多くスマホでの誤タップを減らす。
              min-h-11(44px) + px-4 で実寸タップ面積を確保。                          */}
          <div className="flex items-center justify-center gap-1.5">
            <NavButton
              label="⏮"
              ariaLabel="先頭へ"
              onClick={() => setIndex(0)}
              disabled={!game || index === 0}
            />
            <NavButton
              label="◀"
              ariaLabel="1手戻る"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={!game || index === 0}
            />
            <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-muted">
              {index} / {max}
            </span>
            <NavButton
              label="▶"
              ariaLabel="1手進む"
              onClick={() => setIndex((i) => Math.min(max, i + 1))}
              disabled={!game || index === max}
            />
            <NavButton
              label="⏭"
              ariaLabel="末尾へ"
              onClick={() => setIndex(max)}
              disabled={!game || index === max}
            />
          </div>
        </section>

        {/* ── サイドパネル: 棋譜読み込み + 手順表 + 解説 ── */}
        <aside className="flex flex-col gap-4">
          {/* PGN 読み込みセクション */}
          <details open className="group rounded-xl border border-border bg-surface-2 p-4">
            <summary className="focus-ai -m-1 cursor-pointer rounded p-1 text-sm font-semibold text-on-surface">
              棋譜を読み込む（PGN）
            </summary>

            <div className="mt-3 flex flex-col gap-2">
              <textarea
                value={pgnText}
                onChange={(e) => setPgnText(e.target.value)}
                rows={5}
                spellCheck={false}
                /* フォント: monospace を明示。日本語入力時も崩れない。 */
                className="w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-xs text-on-surface placeholder:text-subtle focus:border-ai focus:outline-none"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleLoad}
                  /* 藍アクセントのプライマリアクション */
                  className="focus-ai rounded-lg bg-ai px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ai-hover dark:bg-ai-dim dark:hover:bg-ai"
                >
                  読み込む
                </button>
                {error && (
                  /* text-[var(--q-miss-fg)]: q-miss 変数は @theme 外なので任意値で参照 */
                  <p className="text-xs text-[var(--q-miss-fg)]" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </details>

          {/* 手順表 */}
          {game && (
            <MoveList
              moves={game.moves}
              currentIndex={index}
              qualities={qualities}
              onSelect={setIndex}
            />
          )}

          {/* 解説パネル */}
          <div className="rounded-xl border border-border bg-surface-2 p-4">
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
      className="focus-ai min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:bg-surface-2 disabled:opacity-30"
    >
      {label}
    </button>
  );
}
