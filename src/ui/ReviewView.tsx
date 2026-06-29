import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessGame } from '../core/game';
import { buildExplanationContext } from '../core/classify';
import type { ExplanationContext, KnowledgeProfile, MoveQuality } from '../core/types';
import type { ChessEngine } from '../engine/types';
import { createEngine, type EngineKind } from '../engine/factory';
import { requestExplanation } from '../explain/client';
import { Board } from './Board';
import { MoveList } from './MoveList';
import { ExplanationPanel, type ChatTurn } from './ExplanationPanel';
import { SAMPLE_PGN } from './sample';

const LEVELS: KnowledgeProfile['level'][] = ['beginner', 'intermediate', 'advanced'];
const LEVEL_LABEL: Record<NonNullable<KnowledgeProfile['level']>, string> = {
  beginner: '初心者',
  intermediate: '中級',
  advanced: '上級',
};

/** 棋譜振り返り画面(PoC の縦貫通)。 */
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
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>
          エンジン:{' '}
          {engineKind === 'loading'
            ? '読み込み中…'
            : engineKind === 'stockfish'
              ? 'Stockfish (WASM)'
              : 'モック（簡易評価）'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          レベル:
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setLevel(lv!)}
              className={`rounded px-2 py-0.5 ${
                level === lv
                  ? 'bg-slate-300 dark:bg-slate-600'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {LEVEL_LABEL[lv!]}
            </button>
          ))}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* 盤 + 操作 */}
        <section className="flex flex-col gap-3">
          <div className="mx-auto w-full max-w-[480px]">
            <Board fen={fen} lastMoveUci={lastMoveUci} />
          </div>
          <div className="flex items-center justify-center gap-2">
            <NavButton label="⏮" onClick={() => setIndex(0)} disabled={!game || index === 0} />
            <NavButton
              label="◀"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={!game || index === 0}
            />
            <span className="min-w-16 text-center text-sm text-slate-500">
              {index} / {max}
            </span>
            <NavButton
              label="▶"
              onClick={() => setIndex((i) => Math.min(max, i + 1))}
              disabled={!game || index === max}
            />
            <NavButton label="⏭" onClick={() => setIndex(max)} disabled={!game || index === max} />
          </div>
        </section>

        {/* 解説・棋譜 */}
        <aside className="flex flex-col gap-4">
          <details open className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <summary className="cursor-pointer text-sm font-semibold">
              棋譜を読み込む（PGN）
            </summary>
            <textarea
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
              rows={5}
              className="mt-2 w-full rounded-md border border-slate-300 p-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-900"
            />
            <button
              onClick={handleLoad}
              className="mt-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              読み込む
            </button>
            {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
          </details>

          {game && (
            <MoveList
              moves={game.moves}
              currentIndex={index}
              qualities={qualities}
              onSelect={setIndex}
            />
          )}

          <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <h2 className="mb-2 text-sm font-semibold">解説・対話</h2>
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

function NavButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-200 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-700"
    >
      {label}
    </button>
  );
}
