import { useEffect, useState } from 'react';

const FEEDBACK_URL = import.meta.env.VITE_FEEDBACK_URL as string | undefined;
const KOFI_URL = import.meta.env.VITE_KOFI_URL as string | undefined;

/**
 * Phase 0 のアプリシェル。
 * - レスポンシブ(モバイルファースト)の骨組み
 * - crossOriginIsolated の状態表示(WASMマルチスレッド可否の検証用)
 * - フィードバック / Ko-fi 導線
 * 機能(盤・解析・解説)は後続フェーズで追加する。
 */
function App() {
  const [isolated, setIsolated] = useState<boolean | null>(null);

  useEffect(() => {
    setIsolated(typeof window !== 'undefined' ? window.crossOriginIsolated : null);
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h1 className="text-lg font-bold sm:text-xl">Chess-Japan — 1手解説AI</h1>
        <nav className="flex items-center gap-3 text-sm">
          {FEEDBACK_URL && (
            <a
              className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
              href={FEEDBACK_URL}
              target="_blank"
              rel="noreferrer"
            >
              フィードバック
            </a>
          )}
          {KOFI_URL && (
            <a
              className="rounded-md bg-rose-500 px-3 py-1 font-medium text-white hover:bg-rose-600"
              href={KOFI_URL}
              target="_blank"
              rel="noreferrer"
            >
              ☕ 支援する
            </a>
          )}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {/* スマホ:1カラム → タブレット/PC:多カラム */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="mb-2 text-base font-semibold">盤面（実装予定）</h2>
            <p className="text-sm text-slate-500">
              Phase 1 で chessground 盤 + Stockfish(WASM) 解析を追加します。
            </p>
          </section>
          <aside className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="mb-2 text-base font-semibold">解説・対話（実装予定）</h2>
            <p className="text-sm text-slate-500">
              各手の解説と「どういうこと？」追問チャットを表示します。
            </p>
          </aside>
        </div>
      </main>

      <footer className="border-t border-slate-200 px-4 py-3 text-center text-xs text-slate-500 dark:border-slate-800">
        WASMマルチスレッド(crossOriginIsolated):{' '}
        {isolated === null ? '確認中…' : isolated ? '✅ 有効' : '❌ 無効（COOP/COEP要確認）'}
      </footer>
    </div>
  );
}

export default App;
