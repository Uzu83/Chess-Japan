/*
 * webAnalytics.ts — Cloudflare Web Analytics のビーコン（任意）
 *
 * VITE_CF_WEB_ANALYTICS_TOKEN が空、または 32 桁の16進でなければ何もしない。
 * この値はサイト識別用の公開トークンで、秘密の API キーではない。
 * ダッシュボードの有効化と Pages の環境変数は人が行う。ここには埋め込まない。
 *
 * 計測は Cookie なしの集計だけ。spa:true は履歴の変化も数える（このアプリは SPA）。
 * 送信先は https://cloudflareinsights.com/cdn-cgi/rum 。CSP は
 * public/_headers と vercel.json で script / connect を許可する。
 * スニペットとダッシュボードの自動注入を両方有効にすると二重計上になる。
 */

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/** Cloudflare のサイトトークン。属性へそのまま入れるため、この形以外は拒否する。 */
const TOKEN_PATTERN = /^[a-f0-9]{32}$/i;

/**
 * トークンがあるときだけビーコンを 1 つ挿す。未設定・不正値は no-op。
 */
export function mountWebAnalyticsIfConfigured(doc: Document = document): void {
  const token = import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN?.trim() ?? '';
  if (!TOKEN_PATTERN.test(token)) return;
  if (doc.querySelector(`script[src="${BEACON_SRC}"]`)) return;

  const script = doc.createElement('script');
  script.type = 'module';
  script.src = BEACON_SRC;
  script.dataset.cfBeacon = JSON.stringify({ token, spa: true });

  const parent = doc.body ?? doc.head;
  parent?.append(script);
}
