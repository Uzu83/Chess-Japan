/*
 * sentry.ts — 本番エラー監視の初期化(隔離モジュール)
 *
 * 設計方針(Codex ゲート①で合意済み・2026-07-07):
 *   - VITE_SENTRY_DSN が未設定なら「何もしない」= SDK の import すら走らない。
 *     WHY 動的 import か: CI・フォーク・ローカル dev では Sentry を完全無効にでき、
 *     初期チャンクに SDK(数十KB gzip)を混ぜない。エラー監視の主目的は
 *     「通常利用中の例外検知」なので、この遅延は許容(下の非目標を参照)。
 *   - 【非目標・明記】起動時の白画面(App.tsx や依存モジュールの評価時エラー、
 *     init 完了前の render エラー)は捕捉できない。main.tsx は App を静的 import して
 *     いるため、SDK ロード分岐に到達する前に落ちるケースがある。これを監視したく
 *     なったら bootstrap 分離(エントリを2段に割る)が必要 — 今はそこまでしない。
 *   - tracesSampleRate: 0 / Replay なし: パフォーマンス計測は目的外。
 *     Sentry 無料枠 quota とバンドルを守る(エラーイベントのみに絞る)。
 *   - sendDefaultPii: false: ユーザー IP 等を「イベントに付与しない」指示。
 *     ただしこれは Sentry 側が通信元 IP を一切保持しない保証ではない(Codex 指摘)。
 *     悪用対策(公開 DSN への第三者スパム)は Sentry ダッシュボード側の
 *     Allowed Domains 設定で行う — .env.example の運用メモ参照。
 *
 * DSN は公開値(ブラウザに露出して良い)。秘密は Supabase secrets のみ、という
 * このプロジェクトの信頼境界は変わらない。
 *
 * 【ビルド時挙動・実測済み(2026-07-07)】Vite は import.meta.env.VITE_SENTRY_DSN を
 * ビルド時に定数展開する。DSN 未設定ビルドでは下の分岐が静的に死に、Rollup が
 * 動的 import ごと除去する → Sentry チャンク自体が生成されない(dist に無くて正常)。
 * DSN 設定ビルドでは別チャンク(約159KB gzip)が生成され遅延ロードされる。
 * つまり「DSN を後から設定したら再ビルド + 再デプロイが必要」— ランタイム注入ではない。
 */

/**
 * DSN が設定されている場合のみ Sentry を遅延初期化する。
 * 戻り値は待つ必要なし(init 完了前に render を始めて良い — ゲート①で合意)。
 */
export function initSentryIfConfigured(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return; // 未設定 = 監視オフ。CI/フォーク/ローカルは通常ここで終わり。

  // 失敗しても本体機能に影響させない(監視はベストエフォート)。
  import('@sentry/react')
    .then((Sentry) => {
      Sentry.init({
        dsn,
        sendDefaultPii: false,
        // パフォーマンストレースは送らない(エラー監視専用。quota 節約)。
        tracesSampleRate: 0,
        // 最小 scrub(Codex 指摘の採用): URL の query/hash を落とす。
        // 現状 URL に個人情報を乗せる設計は無いが、将来誰かが ?fen=... のような
        // パラメータを足したときに黙って Sentry へ流れる事故を先回りで防ぐ。
        beforeSend(event) {
          if (event.request?.url) {
            try {
              const u = new URL(event.request.url);
              event.request.url = u.origin + u.pathname;
            } catch {
              // URL パース不能なら丸ごと落とす(欠損させる方が漏洩より安全)
              event.request.url = undefined;
            }
          }
          return event;
        },
      });
    })
    .catch(() => {
      // SDK ロード失敗(ネットワーク・広告ブロッカー等)は握りつぶす。
      // console を汚すとユーザーの不安を煽るだけで対処可能性が無い。
    });
}
