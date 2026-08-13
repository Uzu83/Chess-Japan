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

/*
 * トークン取得の上限（2026-08-13 追加・実害の再発防止）。
 *
 * WHY 必要か: appearance:'interaction-only' は「bot 疑い」のときだけウィジェットを可視化する。
 *   その挑戦をユーザーが完了しない限り Turnstile の callback は永久に呼ばれず、
 *   getTurnstileToken() の Promise が解決しないままになる。本番 QA で、解説が
 *   「AI が解説を生成中です…」のまま無限に回り続ける事象として観測された（実際は人間確認待ち）。
 *   時間切れを設けて呼び出し側へ制御を返し、ユーザーへ何をすべきか伝えられるようにする。
 *   12 秒: 挑戦が出ない通常ケース（数百 ms）には十分すぎる余裕があり、かつ人間が
 *   「固まった」と感じる前に案内を出せる長さ。
 */
const TOKEN_TIMEOUT_MS = 12_000;

/*
 * 先回り取得したトークンを有効とみなす時間。Turnstile のトークンは単発使用・300 秒で失効するため、
 * 失効ぎりぎりを掴まないよう短めに切る。
 */
const PREFETCH_TTL_MS = 240_000;

let prefetched: { token: string; at: number } | null = null;

/** 先回り取得済みトークンを取り出す（単発使用なので、古くても必ず捨てる）。 */
function takePrefetched(): string | null {
  if (!prefetched) return null;
  const fresh = Date.now() - prefetched.at < PREFETCH_TTL_MS;
  const token = fresh ? prefetched.token : null;
  prefetched = null;
  return token;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('turnstile timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

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

/** 実際に reset→execute してトークンを1つ発行させる（直列化前の生の処理）。 */
async function execute(): Promise<string | null> {
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
}

/*
 * 進行中の取得。**同時に2本走らせない**のが最重要（GPT 監査 2026-08-13 P1）。
 *
 * WHY: execute() は毎回 reset() で前のトークンを破棄する。先回り取得が人間確認を待っている
 *   最中に getTurnstileToken() が別の execute を積むと、完了したばかりの先回りトークンを
 *   その reset が無効化し、挑戦をもう一度やり直させてしまう。
 *   進行中の Promise を共有し、**結果の書き込み先も prefetched ひとつに集約**して、
 *   「発行するのは runOnce だけ・消費するのは takePrefetched だけ」にする（二重消費の排除）。
 */
let inflight: Promise<void> | null = null;

function runOnce(): Promise<void> {
  if (inflight) return inflight;
  // 直前の取得が終わってから実行（成否問わず次へ）。鎖自体の失敗は握りつぶして詰まらせない。
  const raw = chain.then(execute, execute);
  chain = raw.catch(() => {});
  const tracked = raw.then(
    (t) => {
      inflight = null;
      if (t) prefetched = { token: t, at: Date.now() };
    },
    (e: unknown) => {
      inflight = null;
      throw e instanceof Error ? e : new Error(String(e));
    },
  );
  inflight = tracked;
  return tracked;
}

/**
 * リクエスト毎の新鮮な Turnstile トークンを取得する。
 *   - site key 未設定なら null（＝ヘッダを付けない。バックエンドも非課金環境では検証 skip）。
 *   - トークンは単発使用なので毎回 reset→execute で新規発行し、callback 経由で受け取る。
 *   - 直列化（chain）で同時実行を防ぐ（pending スロットは1つ）。
 *   - 先回り取得済み（prefetchTurnstileToken）があればそれを消費して即返す。
 *   - TOKEN_TIMEOUT_MS を超えたら `turnstile timeout` で reject し、呼び出し側が案内を出せるようにする。
 */
export function getTurnstileToken(): Promise<string | null> {
  if (!SITE_KEY) return Promise.resolve(null);

  const ready = takePrefetched();
  if (ready) return Promise.resolve(ready);

  /*
   * 時間切れになっても runOnce の結果は prefetched に残る。捨てないので、
   * ユーザーが遅れて人間確認を完了したあとの「再試行」は即座に通る。
   */
  return withTimeout(runOnce(), TOKEN_TIMEOUT_MS).then(() => takePrefetched());
}

/**
 * **待たずに**使えるトークンを取り出す。無ければ null（挑戦を出さない）。
 *
 * WHY このAPIが要るか（GPT 監査 2026-08-13 P2 の修正）:
 *   解説リクエストは「まずトークン無しで投げる → サーバーがキャッシュヒットなら即返す →
 *   キャッシュに無いときだけ人間確認を求める」という順序にした。その1回目で
 *   `getTurnstileToken()` を await すると、結局そこで挑戦が出てキャッシュ経路が塞がる。
 *   手元にある分だけ付けて、無ければ付けずに投げるための同期版。
 */
export function takeReadyTurnstileToken(): string | null {
  if (!SITE_KEY) return null;
  return takePrefetched();
}

/**
 * トークンを先回りで用意しておく（2026-08-13 追加）。
 *
 * WHY: 解説ボタンを押してから script ロード → widget 生成 → execute を始めると、その待ち時間が
 *   まるごと「解説が出ない時間」になる。レビュー画面に入った時点で裏で取っておけば、
 *   押した瞬間に手元のトークンを使えて体感の摩擦が消える。
 *   失敗しても黙って諦める（本来の取得は getTurnstileToken 側でやり直せるため）。
 */
export function prefetchTurnstileToken(): void {
  if (!SITE_KEY) return;
  if (prefetched && Date.now() - prefetched.at < PREFETCH_TTL_MS) return;
  void runOnce().catch(() => {});
}
