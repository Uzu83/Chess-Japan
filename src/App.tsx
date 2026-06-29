import { useEffect, useState } from 'react';
import { ReviewView } from './ui/ReviewView';

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

      <main className="flex-1">
        <ReviewView />
      </main>

      <footer className="border-t border-slate-200 px-4 py-3 text-center text-xs text-slate-500 dark:border-slate-800">
        WASMマルチスレッド(crossOriginIsolated):{' '}
        {isolated === null ? '確認中…' : isolated ? '✅ 有効' : '❌ 無効（COOP/COEP要確認）'}
      </footer>
    </div>
  );
}

export default App;
