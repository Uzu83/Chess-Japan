import { useEffect, useState } from 'react';
import { ReviewView } from './ui/ReviewView';

const FEEDBACK_URL = import.meta.env.VITE_FEEDBACK_URL as string | undefined;
const KOFI_URL = import.meta.env.VITE_KOFI_URL as string | undefined;

/*
 * App — アプリシェル
 *
 * 「静かな日本的モダン」世界観:
 *   - ヘッダー: 余白重視、藍のタイポ、最小限のナビ
 *   - フッター: crossOriginIsolated は開発者向け情報なのでステータスドットに縮小。
 *     エンドユーザーには不要な情報をメインUIから退かす。
 *     WHY ドットだけにする: WASM マルチスレッドの可否はデプロイ設定の問題であり
 *     一般ユーザーには何も対処できない情報。DevTools 派向けに title 属性で残す。
 *   - Ko-fi リンク: rose ベタ塗りから藍ラインに変更(多色使い禁止ルール)。
 */
function App() {
  const [isolated, setIsolated] = useState<boolean | null>(null);

  useEffect(() => {
    setIsolated(typeof window !== 'undefined' ? window.crossOriginIsolated : null);
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-surface text-on-surface">
      {/* ── ヘッダー ── */}
      <header className="border-b border-border px-5 py-3.5">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          {/* アプリタイトル — 藍色で品のある存在感を出す。
               WHY 子要素を使わず単一テキストノード: RTL の getByText はテキストが
               複数の子要素に分かれると h1.textContent が一致しても検出できない
               (実際に確認済み)。App.test.tsx のアサーション変更は CLAUDE.md で NG
               のため、単一テキストノードで h1 の textContent を "Chess-Japan — 1手解説AI"
               のまま保つ設計を採用した。                                          */}
          <h1 className="text-base font-semibold tracking-wide text-ai sm:text-lg">
            Chess-Japan — 1手解説AI
          </h1>

          <nav className="flex items-center gap-3">
            {FEEDBACK_URL && (
              <a
                className="focus-ai rounded px-2 py-1 text-sm text-muted transition-colors hover:text-on-surface"
                href={FEEDBACK_URL}
                target="_blank"
                rel="noreferrer"
              >
                フィードバック
              </a>
            )}
            {KOFI_URL && (
              /* 差し色(藍)のみ。rose は多色使いになるため除外。
                 Ko-fi 本家オレンジを使わない理由: 藍と競合し世界観を壊す。 */
              <a
                className="focus-ai rounded border border-ai px-3 py-1 text-sm font-medium text-ai transition-colors hover:bg-ai hover:text-white dark:hover:bg-ai-dim dark:hover:text-white"
                href={KOFI_URL}
                target="_blank"
                rel="noreferrer"
              >
                支援する
              </a>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <ReviewView />
      </main>

      {/* ── フッター ── */}
      <footer className="border-t border-border px-5 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          {/* GPLv3 クレジット — プロジェクトの公開表記ポリシーに従い残す */}
          <p className="text-xs text-subtle">
            Stockfish・chessground:{' '}
            <a
              href="https://github.com/toshikidev/chess-japan"
              target="_blank"
              rel="noreferrer"
              className="focus-ai underline-offset-2 hover:underline"
            >
              GPLv3
            </a>
          </p>

          {/* WASM マルチスレッド状態インジケーター
              エンドユーザーには意味がないため 6px のステータスドットに縮小。
              title 属性で DevTools 派が確認できるよう情報は保持する。 */}
          <span
            title={`WASM マルチスレッド(crossOriginIsolated): ${
              isolated === null ? '確認中' : isolated ? '有効' : '無効 — COOP/COEP を確認'
            }`}
            aria-label={`WASMステータス: ${isolated === null ? '確認中' : isolated ? '有効' : '無効'}`}
            /* q-good-fg / q-miss-fg は @theme 外の CSS 変数のため Tailwind 任意値で参照。
               WHY @theme に入れない: quality バッジ専用変数を他で使い回すと管理が分散する。 */
            className={[
              'block h-1.5 w-1.5 rounded-full',
              isolated === null
                ? 'bg-subtle'
                : isolated
                  ? 'bg-[var(--q-good-fg)]'
                  : 'bg-[var(--q-miss-fg)]',
            ].join(' ')}
          />
        </div>
      </footer>
    </div>
  );
}

export default App;
