// Cloudflare Turnstile クライアント連携（#2 の“最後の1ピース”・公開直前）。
//
// WHY / 設計（2026-07-01）:
//   バックエンド(explain Edge Function)は「課金キーがある環境」で Turnstile を必須検証する（docs/COST_DEFENSE.md #2）。
//   Turnstile トークンは “単発使用・300秒で失効”。局面ごとに解説を投げるこのアプリでは 1 トークン使い回しができないので、
//   execute モードで「リクエスト毎に reset→execute して新トークン」を取る。バックエンドは変更不要（既に毎回検証）。
//   VITE_TURNSTILE_SITE_KEY 未設定なら完全 no-op（dev/preview・キー無し環境でフローを壊さない＝ローカル解説に落ちる）。
//   appearance:'interaction-only' なので、bot 疑い時だけウィジェットが可視化（人間はほぼ何も見えない）。
//   ※ 配置/見た目（どこに出すか）は後でデザインで詰める前提。ここではまず“正しい配線”を確定する。
//   API 出典: Cloudflare Turnstile client-side rendering（explicit / execution:'execute' / reset / execute）。

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Turnstile が有効か（site key 設定済みか）。UI 側の出し分けにも使える。 */
export function isTurnstileEnabled(): boolean {
  return Boolean(SITE_KEY);
}

// window.turnstile の最小型（このモジュールで使う関数だけ宣言）。
interface TurnstileApi {
  render(el: string | HTMLElement, opts: Record<string, unknown>): string;
  execute(el: string | HTMLElement): void;
  reset(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
let widgetId: string | null = null;
let container: HTMLElement | null = null;
// 実行中の execute の解決先。Turnstile の callback がここへ token を届ける。
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
// トークン取得を直列化する鎖。同時に複数 execute を走らせない（pending スロットは1つしか持てない）。
let chain: Promise<unknown> = Promise.resolve();

/** Turnstile スクリプトを1度だけ動的ロード（site key があるときだけ呼ばれる）。 */
function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Turnstile script load failed'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** ウィジェットを1度だけ生成（execute モード・interaction-only）。 */
function ensureWidget(): void {
  if (widgetId || !window.turnstile || !SITE_KEY) return;
  // 暫定配置（デザイン未確定）: 画面右下に固定。interaction-only なので通常は不可視、挑戦が要るときだけ出る。
  container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.bottom = '8px';
  container.style.right = '8px';
  container.style.zIndex = '9999';
  document.body.appendChild(container);
  widgetId = window.turnstile.render(container, {
    sitekey: SITE_KEY,
    execution: 'execute',
    appearance: 'interaction-only',
    callback: (token: string) => {
      pending?.resolve(token);
      pending = null;
    },
    'error-callback': () => {
      pending?.reject(new Error('Turnstile challenge failed'));
      pending = null;
    },
    'timeout-callback': () => {
      pending?.reject(new Error('Turnstile timed out'));
      pending = null;
    },
  });
}

/**
 * リクエスト毎の新鮮な Turnstile トークンを取得する。
 *   - site key 未設定なら null（＝ヘッダを付けない。バックエンドも非課金環境では検証 skip）。
 *   - トークンは単発使用なので毎回 reset→execute で新規発行し、callback 経由で受け取る。
 *   - 直列化（chain）で同時実行を防ぐ（pending スロットは1つ）。
 */
export function getTurnstileToken(): Promise<string | null> {
  if (!SITE_KEY) return Promise.resolve(null);
  const run = async (): Promise<string | null> => {
    await loadScript();
    ensureWidget();
    if (!window.turnstile || !widgetId) return null;
    return await new Promise<string>((resolve, reject) => {
      pending = { resolve, reject };
      try {
        window.turnstile!.reset(widgetId!); // 前回トークンを破棄して新しい挑戦へ
        window.turnstile!.execute(container!);
      } catch (e) {
        pending = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };
  // 直前の取得が終わってから実行（成否問わず次へ）。鎖自体の失敗は握りつぶして詰まらせない。
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
