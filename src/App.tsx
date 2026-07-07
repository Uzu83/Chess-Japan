import { useEffect, useState } from 'react';
import { ReviewView } from './ui/ReviewView';
import { PlayView } from './ui/PlayView';

const FEEDBACK_URL = import.meta.env.VITE_FEEDBACK_URL as string | undefined;
const KOFI_URL = import.meta.env.VITE_KOFI_URL as string | undefined;

/** アプリのモード。対局(AI戦) / レビュー(棋譜振り返り)。 */
type Mode = 'play' | 'review';

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
 *
 * モード切替(Phase A: 対局優先):
 *   既定は「対局」。ヘッダーのセグメントで「レビュー」に切り替えられる。
 *   WHY 両ビューを unmount せず hidden で保持するか:
 *     対局中にレビュータブへ切り替えても進行中の対局を失わないため、PlayView は常時マウント。
 *     ReviewView はエンジン worker を余分に起動しないよう「初めてレビューを開くまで遅延マウント」し、
 *     以降は hidden で状態保持する。
 *   「この対局を振り返る」導線:
 *     PlayView が終局 PGN を onReview で渡す → reviewKey を進めて ReviewView を再マウントし、
 *     initialPgn として最優先ロードさせる(ReviewView 側の初期化優先順位 0 番)。
 */
function App() {
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>('play');

  // レビューへ渡す PGN と、振り返りのたびに ReviewView を再マウントするための key。
  const [reviewPgn, setReviewPgn] = useState<string | undefined>(undefined);
  const [reviewKey, setReviewKey] = useState(0);
  // ReviewView を一度でもマウントしたか(遅延マウント + 以降 hidden 保持)。
  const [reviewMounted, setReviewMounted] = useState(false);

  useEffect(() => {
    setIsolated(typeof window !== 'undefined' ? window.crossOriginIsolated : null);
  }, []);

  // 対局からの「振り返る」: PGN を渡してレビューへ切り替え(再マウントで最優先ロード)。
  const handleReview = (pgn: string) => {
    setReviewPgn(pgn);
    setReviewKey((k) => k + 1);
    setReviewMounted(true);
    setMode('review');
  };

  // レビューからの「この局面から対局」(Phase 2B): FEN を渡して対局へ切り替え。
  // nonce で同一 FEN の再要求も発火させる(PlayView 側が nonce 変化で開始を検知)。
  const [playFrom, setPlayFrom] = useState<{ fen: string; nonce: number } | null>(null);
  const handlePlayFrom = (fen: string) => {
    setPlayFrom((prev) => ({ fen, nonce: (prev?.nonce ?? 0) + 1 }));
    setMode('play');
  };

  // タブ切替。レビューを開いたら以降マウント状態を保つ。
  const switchMode = (m: Mode) => {
    if (m === 'review') setReviewMounted(true);
    setMode(m);
  };

  return (
    // min-h-dvh: 動的ビューポート高で「最低でも画面いっぱい・コンテンツが長ければ伸びる」。
    // min-h-full(親の%依存)はモバイルで下端スクロール切れの原因になるため dvh に変更。
    <div className="flex min-h-dvh flex-col bg-surface text-on-surface">
      {/* ── ヘッダー ── */}
      {/*
       * shadow-card を加えてヘッダーにわずかな浮き感を与える。
       * bg-surface を明示: shadow が透過背景で破綻しないよう自身の背景を確定させる。
       */}
      <header className="border-b border-border bg-surface px-5 py-3.5 shadow-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          {/* アプリタイトルエリア
               WHY h1 は単一テキストノードのまま: getByText('Chess-Japan — 1手解説AI')
               が h1 の textContent に一致する必要があるため、子要素で分割しない設計を維持
               (実際に確認済み。App.test.tsx のアサーション変更は CLAUDE.md で NG)。
               ♟ グリフは h1 の兄弟 span として配置 → h1.textContent は変わらない。 */}
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="select-none text-xl text-ai opacity-60">
              ♟
            </span>
            <h1 className="text-base font-semibold tracking-wide text-ai sm:text-lg">
              Chess-Japan — 1手解説AI
            </h1>
          </div>

          <nav className="flex items-center gap-3">
            {/* モード切替([対局 | レビュー])
                WHY tablist でなく aria-pressed トグルか(reviewer 指摘):
                  完全な ARIA tabs パターン(tabpanel/aria-controls/矢印キー/roving tabindex)を
                  満たさないまま role="tab" を名乗ると SR の期待を裏切る。SetupScreen の色/難度
                  選択と同じ「押下状態トグルボタン」に統一し、実装方針を揃える。
                min-h-11: 自プロジェクトの 44px タップ領域規約に合わせる。
                デザイン改善: rounded-xl + bg-surface + shadow-card でセグメントコントロール的な
                質感。選択タブは shadow-btn でわずかに浮いて「押されている感」を強調。 */}
            <div
              aria-label="モード切替"
              className="flex rounded-xl border border-border bg-surface p-0.5 shadow-card"
            >
              {(
                [
                  { m: 'play' as const, label: '対局' },
                  { m: 'review' as const, label: 'レビュー' },
                ] satisfies { m: Mode; label: string }[]
              ).map(({ m, label }) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => switchMode(m)}
                  className={[
                    // whitespace-nowrap: モバイル幅でタブ文字(「レビュー」等)が縦に折り返すのを防ぐ
                    'focus-ai min-h-11 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors',
                    mode === m
                      ? 'bg-ai text-white shadow-btn dark:bg-ai-dim'
                      : 'text-muted hover:text-on-surface',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>

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
        {/* PlayView は常時マウント(対局中の状態をタブ切替で失わない)。 */}
        <div className={mode === 'play' ? '' : 'hidden'}>
          <PlayView onReview={handleReview} playFrom={playFrom} />
        </div>

        {/* ReviewView は初回レビューまで遅延マウント。以降 hidden で状態保持。
            reviewKey を変えると再マウントされ initialPgn を最優先で読み込む。 */}
        {reviewMounted && (
          <div className={mode === 'review' ? '' : 'hidden'}>
            <ReviewView
              key={reviewKey}
              initialPgn={reviewPgn}
              active={mode === 'review'}
              onPlayFrom={handlePlayFrom}
            />
          </div>
        )}
      </main>

      {/* ── フッター ── */}
      <footer className="border-t border-border px-5 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          {/* GPLv3 クレジット — プロジェクトの公開表記ポリシーに従い残す。
              プライバシーポリシーは静的 HTML(public/privacy.html)への通常リンク。
              WHY 同タブ遷移: SPA 外の独立ページで「← 戻る」リンクを持つため target=_blank 不要。 */}
          <p className="text-xs text-subtle">
            Stockfish・chessground:{' '}
            <a
              href="https://github.com/Uzu83/Chess-Japan"
              target="_blank"
              rel="noreferrer"
              className="focus-ai underline-offset-2 hover:underline"
            >
              GPLv3
            </a>
            <span aria-hidden="true" className="mx-2 select-none">
              ·
            </span>
            <a href="/privacy.html" className="focus-ai underline-offset-2 hover:underline">
              プライバシー
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
