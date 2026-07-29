// Supabase Edge Function: 解説/対話 LLM プロキシ（コスト防衛つき）
//
// 役割:
//   - APIキーをサーバー側に秘匿し、フロントから安全に LLM を呼ぶ
//   - 入力検証 / body上限 / CORS / レート制限 / 日次クォータ / Turnstile / キャッシュ で
//     「公開LLMエンドポイント濫用によるコスト爆発」を多層防御（収益ゼロ前提の最重要対策）
//   - プロバイダ抽象（既定 Claude Sonnet 4.6、比較/フォールバックに Grok・Gemini）
//   - 解説(explain) と 追問(followup) の2モード
//
// 2026-06-29〜30 の経緯（WHY / 再発防止）:
//   - Codex×多観点レビューで Phase0/1 の Edge Function を堅牢化（入力検証/byteLength/CORS/注入緩和）。
//   - 本ファイルで Supabase の RLS ロック済みテーブル（explain_cache / rate_counters）へ service_role で接続し、
//     共有ストアのレート制限・日次クォータ・解説キャッシュを“本実装”。インメモリの気休めを置き換えた。
//   - 解説の既定モデルをオーナー要望で Grok → Claude Sonnet 4.6 に格上げ（品質重視）。
//     プロバイダ抽象は raw HTTP のまま（proxy 全体が provider 別 raw fetch。SDK を1つだけ混ぜない＝対称性/bundle）。
//   - プロンプトインジェクション対策を強化（system は固定指示のみ、ユーザー由来は user 側の“データ柵”に隔離）。
//
// 秘密（Supabase secrets に設定。ブラウザにもgitにも出さない）:
//   ANTHROPIC_API_KEY（既定プロバイダ Claude）/ XAI_API_KEY（Grok）/ GEMINI_API_KEY（Gemini）
//   TURNSTILE_SECRET（課金キーがある環境では必須＝未設定なら 503。キー無しの dev/preview のみ任意）
//   ALLOWED_ORIGINS（本番は必須。例 https://chess-japan.pages.dev）
//   LLM_PROVIDER（claude|grok|gemini。既定 claude）/ CLAUDE_MODEL / GROK_MODEL / GEMINI_MODEL
//   RATE_PER_MIN（既定15）/ RATE_PER_DAY（既定200）
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY はホスト環境が自動注入（手動設定不要）。
//
// デプロイ: supabase functions deploy explain

// deno-lint-ignore-file no-explicit-any

import {
  MAX_BODY_BYTES,
  byteLengthOf,
  cacheKeyInput,
  validateExplainBody,
  type ExplainBody,
} from '../_shared/validate.ts';
// buildPrompt は _shared/prompt.ts に切り出し済み(2026-07-16・explain-label-data-plan.md ゲート① F001)。
// 純ロジックを Deno 非依存にして vitest でテストできるようにする validate.ts と同じパターン。
import { buildPrompt } from '../_shared/prompt.ts';
import { getAuthUser } from '../_shared/authUser.ts';
import {
  FREE_DAY_LIMIT,
  PRO_DEEP_MONTH_LIMIT,
  PRO_FLASH_DAY_LIMIT,
  RATE_WINDOW_DAY,
  RATE_WINDOW_MONTH,
  shouldUseDeepModel,
  type Plan,
} from '../_shared/billingPlans.ts';
import { resolveCors as resolveCorsShared } from '../_shared/cors.ts';
import { fetchProfileBilling, isProEntitled } from '../_shared/stripeProfile.ts';
import {
  clientIp as sharedClientIp,
  resolveTurnstileHostnames,
  verifyTurnstileToken,
} from '../_shared/turnstile.ts';

// ---- 設定値（マジックナンバーの根拠はコメントに固定） ----
// レート制限/クォータ。1人開発・収益ゼロ前提で「正当な利用は十分通し、自動濫用は止める」値。
const RATE_PER_MIN = Number(Deno.env.get('RATE_PER_MIN') ?? '15'); // 1分あたり（1局を数十手レビューしても足りる）
const RATE_PER_DAY = Number(Deno.env.get('RATE_PER_DAY') ?? String(FREE_DAY_LIMIT)); // 匿名IP・決定値50

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
// 本番(ホスト環境)判定。Supabase/Deno Deploy は必ずこの環境変数を持つ。ローカル serve には無い。
const IS_HOSTED = Boolean(Deno.env.get('DENO_DEPLOYMENT_ID'));

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// service_role でのみ RLS をバイパスして内部テーブルへアクセスできる。両方そろって初めて共有ストアが使える。
const STORE_READY = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

// 課金しうるプロバイダキーが1つでもあるか＝「お金が出る」環境かどうか。
// なぜ必要か（Codex 合意 2026-06-30・旧 fail-closed の弱点補強）:
//   hosted 判定を DENO_DEPLOYMENT_ID 単独に頼ると、その変数が外れた環境で IS_HOSTED=false かつ
//   STORE_READY=false になり rateCheck が素通し('ok')→ 実キーがあると無防備に課金されうる。
//   そこで「課金キーがある環境では、共有レート制限ストアの存在を必ず要求する」不変条件を別途立てる。
const HAS_PROVIDER_KEY = Boolean(
  Deno.env.get('ANTHROPIC_API_KEY') ||
  Deno.env.get('XAI_API_KEY') ||
  Deno.env.get('GEMINI_API_KEY'),
);
// fail-closed を強制すべき環境＝hosted、または“課金キーがある”環境。これを満たすのに store が無ければ遮断する。
// 開発トレードオフ: ローカルで実LLMを試したいときは、ローカル Supabase ストアも併走させること
//   （実キーだけ置いて store 無し＝設計上わざと 503。お金が出る経路をレート制限なしで開けないため）。
const ENFORCE_STORE = IS_HOSTED || HAS_PROVIDER_KEY;

const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET');

// Turnstile を必須化すべき環境か（公開前ブロッカー #2 の結論・2026-06-30）。
// なぜ Turnstile を“硬い防壁”にするか / なぜ IP では不足か（WHY・再発防止）:
//   調査結論: Supabase Edge の client IP 源は公式に x-forwarded-for だが「空のことがある」既知の不安定さがあり、
//   詐称防止も保証されていない（cf-connecting-ip も前提にできない）。つまり IP ベースのレート制限は best-effort で
//   コスト防衛の“硬い”信頼境界にはできない。そこで IP 非依存の人間性証明＝Turnstile を、課金しうる環境で必須化し、
//   bot 由来のコスト爆発を IP 詐称に関係なく止める。ENFORCE_STORE(#1) と同じ「お金が出るなら必ず防壁」思想。
//   real key が無い preview/dev では不要（テスト/開発を止めない）。
const ENFORCE_TURNSTILE = HAS_PROVIDER_KEY;

/**
 * Origin に対する CORS 判定とヘッダ。allowed=false なら呼び出し側は preflight 以外を 403 にする。
 * 注意(合意点): CORS は curl 等の直叩きを防げない＝“補助策”。主防壁はレート制限/クォータ/Turnstile/入力検証。
 */
function resolveCors(origin: string | null): { allowed: boolean; headers: Record<string, string> } {
  return resolveCorsShared({
    origin,
    allowedOrigins: ALLOWED_ORIGINS,
    isHosted: IS_HOSTED,
    allowHeaders: 'authorization, content-type, x-turnstile-token',
  });
}

const TURNSTILE_HOSTNAMES = resolveTurnstileHostnames(
  Deno.env.get('TURNSTILE_ALLOWED_HOSTNAMES') ?? undefined,
  Deno.env.get('ALLOWED_ORIGINS') ?? undefined,
);

// ---- body をストリームで読み、上限超過時は読み切らず打ち切る（Content-Length 偽装/欠落に強い） ----
async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) {
    const t = await req.text();
    return byteLengthOf(t) > max ? null : t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// ---- Supabase PostgREST/RPC を service_role で叩く薄いヘルパ（supabase-js を足さず raw fetch で統一） ----
function sbHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// レート判定の3値。boolean だと「超過」と「ストア障害」を区別できず、fail-open/closed を出し分けられない。
//   ok      = 上限内（許可）
//   limited = 上限超過（→ 429）
//   error   = ストア/RPC 障害（hosted では fail-closed=503、local/dev は素通し）
type RateOutcome = 'ok' | 'limited' | 'error';

/**
 * 共有ストアの原子的レート制限。rate_check RPC(SECURITY DEFINER, service_role限定)を呼ぶ。
 *
 * fail-closed 方針（2026-06-30・Codex 保留判定 #1 を反映 / WHY・再発防止）:
 *   旧実装は DB エラー時に true（fail-open）を返していた。だが本番(hosted)で「レート制限が壊れている」は
 *   「コスト防衛が無いまま LLM を叩ける」を意味し、収益ゼロのこのアプリでは課金青天井に直結する。
 *   そこで判定を3値で返し、呼び出し側(handler)が ENFORCE_STORE（hosted か課金キー有）では error を 503 に変換して LLM を叩かせない。
 *   キーも無いローカル/dev は従来どおり素通しにして開発を止めない（出し分けは handler の ENFORCE_STORE 判定）。
 *   関連: docs/COST_DEFENSE.md「公開前にやること #1」。
 */
async function rateCheck(key: string, limit: number, windowSeconds: number): Promise<RateOutcome> {
  // STORE_READY=false は基本ローカルのみ（hosted は handler 冒頭のハードガードで既に 503 済み）。素通し。
  if (!STORE_READY) return 'ok';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rate_check`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: windowSeconds }),
    });
    if (!res.ok) return 'error'; // RPC エラー → hosted では fail-closed（呼び出し側で 503）
    const allowed = await res.json();
    return allowed === true ? 'ok' : 'limited';
  } catch {
    return 'error'; // ネットワーク等の例外も error 扱い（hosted=fail-closed）
  }
}

/** 解説キャッシュ参照（explain のみ）。ヒットすれば本文を返す。 */
async function cacheGet(key: string): Promise<{ explanation: string; provider: string } | null> {
  if (!STORE_READY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/explain_cache?cache_key=eq.${encodeURIComponent(
        key,
      )}&select=explanation,provider`,
      { headers: sbHeaders() },
    );
    if (!res.ok) {
      if (ENFORCE_STORE) console.error(`cacheGet failed: ${res.status}`); // hosted で継続失敗を観測可能に
      return null;
    }
    const rows = (await res.json()) as { explanation: string; provider: string }[];
    return rows.length ? rows[0] : null;
  } catch (err) {
    if (ENFORCE_STORE) console.error('cacheGet error', err);
    return null;
  }
}

/** 解説キャッシュ保存（explain のみ）。upsert（同一キーは衝突マージ）。失敗しても本処理は継続。 */
async function cachePut(
  key: string,
  game: string,
  level: string,
  explanation: string,
  provider: string,
): Promise<void> {
  if (!STORE_READY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/explain_cache?on_conflict=cache_key`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cache_key: key, game, level, explanation, provider }),
    });
    // キャッシュ書込はベストエフォート（失敗しても本処理は継続）。ただし“コスト核”なので、
    // 継続失敗は「同一局面の再課金が止まらない＝コスト跳ね上がり」の予兆。hosted では観測可能にする（Codex指摘⑤）。
    if (!res.ok && ENFORCE_STORE) console.error(`cachePut failed: ${res.status}`);
  } catch (err) {
    if (ENFORCE_STORE) console.error('cachePut error', err);
  }
}

/** Cloudflare Turnstile。secret 未設定はスキップ。設定時は hostname も照合。 */
async function verifyTurnstile(token: string | null, ip: string): Promise<boolean> {
  return verifyTurnstileToken({
    secret: TURNSTILE_SECRET,
    token,
    ip,
    allowedHostnames: TURNSTILE_HOSTNAMES,
  });
}

/**
 * cacheKeyInput(body) に provider/model を足して正規化 JSON 化 → SHA-256 16進（explain のキャッシュキー）。
 * provider/model を含める理由(#3): LLM_PROVIDER やモデルを切り替えたとき、別モデルが生成した旧解説を
 *   返さないため。出力を変える要素はすべてキーに含める（cacheKeyInput が body 側、ここが env 側を担当）。
 */
async function hashCacheKey(body: ExplainBody, provider: string, model: string): Promise<string> {
  const canonical = JSON.stringify({ ...cacheKeyInput(body), provider, model });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- プロバイダの正規化とモデル解決（キーと実呼び出しで“同じ値”を使うための単一の真実源） ----
type Provider = 'claude' | 'grok' | 'gemini';

// プロバイダ別の既定モデル。callX とキャッシュキーの両方がこれを使う＝モデル名のドリフト防止。
//   キャッシュキーに model を含める(#3)ので「実際に叩くモデル」と「キーのモデル」が必ず一致している必要がある。
//   ここを唯一の定義元にして、callClaude 等のインライン既定値の二重管理（＝ズレてキャッシュ不整合の温床）をなくす。
const MODEL_DEFAULTS: Record<Provider, string> = {
  claude: 'claude-sonnet-4-6',
  grok: 'grok-4.1-fast',
  gemini: 'gemini-2.5-flash-lite',
};

/**
 * LLM_PROVIDER を union に正規化（trim・未知値/空は既定 claude）。
 * なぜ正規化するか（Codex 合意 2026-06-30・指摘①）: 未正規化だと "claude " や "foo" がそのままキーの provider に
 *   入り、実呼び出しは callProvider 既定で Claude に落ちる＝同じ実行なのにキーが割れ、応答の provider 表記も実態と
 *   ズレる。キーと実呼び出しで“同じ正規化値”を使うことで #3 の「キー＝実態」不変条件を保つ。
 */
function resolveProvider(): Provider {
  const raw = (Deno.env.get('LLM_PROVIDER') ?? 'claude').trim();
  return raw === 'grok' || raw === 'gemini' ? raw : 'claude';
}

/** provider が実際に使うモデル文字列を解決（env 上書き優先・既定は MODEL_DEFAULTS）。キーと実呼び出しで共用。 */
function resolveModel(provider: Provider): string {
  if (provider === 'grok') return Deno.env.get('GROK_MODEL') ?? MODEL_DEFAULTS.grok;
  if (provider === 'gemini') return Deno.env.get('GEMINI_MODEL') ?? MODEL_DEFAULTS.gemini;
  return Deno.env.get('CLAUDE_MODEL') ?? MODEL_DEFAULTS.claude;
}

/** Pro 深掘り用モデル。Gemini 統一時は GEMINI_PRO_MODEL（既定 gemini-2.5-pro）。 */
function resolveDeepModel(provider: Provider): string {
  if (provider === 'gemini') {
    return Deno.env.get('GEMINI_PRO_MODEL') ?? 'gemini-2.5-pro';
  }
  if (provider === 'claude') {
    return Deno.env.get('CLAUDE_PRO_MODEL') ?? MODEL_DEFAULTS.claude;
  }
  return Deno.env.get('GROK_PRO_MODEL') ?? MODEL_DEFAULTS.grok;
}

// ---- プロバイダ実装（すべて raw HTTP・同一インターフェース。max_tokens=500 でコスト上限を物理的に固定） ----

// callX は handler が解決した model を受け取る（キャッシュキーに使った model と同一を実 payload に渡す＝#3 不変条件）。
/** 既定: Claude Sonnet 4.6。短い解説なので thinking は付けない（adaptive 不要・コスト/レイテンシ最小）。 */
async function callClaude(model: string, system: string, user: string): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY 未設定');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  // 安全分類による拒否（4+ モデルは stop_reason: "refusal" を返しうる）をハンドリング。
  if (data.stop_reason === 'refusal') return '（この内容は解説できませんでした）';
  // content は複数ブロック。text ブロックを連結する。
  const text = (data.content ?? [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('');
  return text;
}

async function callGrok(model: string, system: string, user: string): Promise<string> {
  const key = Deno.env.get('XAI_API_KEY');
  if (!key) throw new Error('XAI_API_KEY 未設定');
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`Grok API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGemini(
  model: string,
  system: string,
  user: string,
  opts?: { deep?: boolean },
): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 未設定');
  const deep = Boolean(opts?.deep);
  // Pro(deep): thinking 無効化不可のため maxOutputTokens を上げる（PLAN・ADR）。
  // Flash: thinkingBudget 0 で本文に予算を全振り。
  const generationConfig: Record<string, unknown> = {
    temperature: 0.4,
    maxOutputTokens: deep ? 2500 : 500,
  };
  if (!deep) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  // A02: API キーを URL クエリに載せない（x-goog-api-key ヘッダ）
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig,
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function callProvider(
  provider: Provider,
  model: string,
  system: string,
  user: string,
  opts?: { deep?: boolean },
): Promise<string> {
  if (provider === 'grok') return callGrok(model, system, user);
  if (provider === 'gemini') return callGemini(model, system, user, opts);
  return callClaude(model, system, user); // 既定
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const { allowed, headers } = resolveCors(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (!allowed)
    return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers });
  if (req.method !== 'POST')
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });

  // クライアント識別子（best-effort・#2）。Supabase Edge の client IP 源は公式に x-forwarded-for だが
  //   「空のことがある／詐称防止は非保証」。よってこの IP は“補助のレート制限”用で、硬い防壁は Turnstile に置く。
  //   cf-connecting-ip は前段が Cloudflare のときだけ付く（無いこともある）ので最優先で読むが、過信しない。
  //   ?? でなく || を使う理由（Codex指摘・空文字バグ修正）: XFF が“空文字”のとき（Supabase で頻発）も
  //   ?? は素通しして ip='' になってしまう。|| なら空文字も次段→最終 'unknown' に正しく倒せる。
  const ip = sharedClientIp(req);

  // 本番ハードガード（fail-closed の入口・Codex 保留判定 #1）:
  //   ENFORCE_STORE（hosted か課金キー有）なのに共有ストア（service_role 接続）が無い＝レート制限/
  //   クォータ/キャッシュが全滅した状態。この状態で LLM を叩かせると無防備に課金されるので 503 で止める。
  //   通常 hosted では SUPABASE_URL / SERVICE_ROLE_KEY は自動注入されるため、ここに来るのは設定事故のとき。
  if (ENFORCE_STORE && !STORE_READY)
    return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503, headers });

  // 本番ハードガード（#2・bot 防壁の必須化）:
  //   課金キーがあるのに Turnstile 未設定だと、コスト防衛が spoofable/不安定な IP だけに依存してしまう。
  //   公開コスト防衛として不十分なので、TURNSTILE_SECRET 未設定なら 503 で止める（＝公開には Turnstile キーが要る）。
  //   real key の無い preview/dev では ENFORCE_TURNSTILE=false なので素通し（テストを止めない）。
  if (ENFORCE_TURNSTILE && !TURNSTILE_SECRET)
    return new Response(JSON.stringify({ error: 'bot protection required' }), {
      status: 503,
      headers,
    });

  // Turnstile 検証。bot による自動濫用を入口で弾く（IP に依存しない人間性証明＝#2 の硬い防壁）。
  //   TURNSTILE_SECRET 設定時のみ実検証（未設定かつ非課金環境では verifyTurnstile が素通し）。
  if (!(await verifyTurnstile(req.headers.get('x-turnstile-token'), ip)))
    return new Response(JSON.stringify({ error: 'turnstile failed' }), { status: 403, headers });

  // 任意 JWT → profiles.plan。anon のままなら free（IP 枠）。
  // WHY checkout 前でも explain は動かす: 無料体験が転換の入口。
  const authUser = await getAuthUser(req, {
    supabaseUrl: SUPABASE_URL,
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? undefined,
    serviceRoleKey: SERVICE_ROLE_KEY,
  });
  let effectivePlan: Plan = 'free';
  let uid: string | null = null;
  if (authUser && STORE_READY && SUPABASE_URL && SERVICE_ROLE_KEY) {
    const billing = await fetchProfileBilling(SUPABASE_URL, SERVICE_ROLE_KEY, authUser.id);
    if (billing && isProEntitled(billing)) {
      effectivePlan = 'pro';
      uid = authUser.id;
    } else if (billing) {
      uid = authUser.id;
    }
  }

  // 共有ストアのレート制限（分）＋日次／月次クォータ。コスト防衛の主防壁。
  const minRate = await rateCheck(`min:ip:${ip}`, RATE_PER_MIN, 60);
  if (minRate === 'limited')
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
  if (minRate === 'error' && ENFORCE_STORE)
    return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
      status: 503,
      headers,
    });

  // Content-Length 先行チェック → ストリーム読みで実バイト上限。
  const declaredLen = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES)
    return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413, headers });
  const raw = await readBodyCapped(req, MAX_BODY_BYTES);
  if (raw === null)
    return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413, headers });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers });
  }

  // 厳格検証（信頼境界）。ここを通った body だけを LLM に渡す。
  const result = validateExplainBody(parsed);
  if (!result.ok)
    return new Response(JSON.stringify({ error: result.error }), { status: 400, headers });
  const body = result.value;

  const depth = body.depth ?? 'standard';
  const useDeep = shouldUseDeepModel(effectivePlan, depth);
  if (depth === 'deep' && effectivePlan !== 'pro') {
    return new Response(JSON.stringify({ error: 'pro required for deep explain' }), {
      status: 402,
      headers,
    });
  }

  const provider = resolveProvider();
  const model = useDeep ? resolveDeepModel(provider) : resolveModel(provider);

  // explain はキャッシュ対象。hit 時はクォータを消費しない（原価ゼロの再利用）。
  let cacheKey: string | null = null;
  if (body.mode === 'explain') {
    cacheKey = await hashCacheKey(body, provider, model);
    const hit = await cacheGet(cacheKey);
    if (hit)
      return new Response(
        JSON.stringify({ text: hit.explanation, provider: hit.provider, cached: true }),
        { headers },
      );
  }

  // 日次/月次枠は LLM 課金前のみ消費。
  if (useDeep && uid) {
    const deepRate = await rateCheck(
      `month:pro:deep:${uid}`,
      PRO_DEEP_MONTH_LIMIT,
      RATE_WINDOW_MONTH,
    );
    if (deepRate === 'limited')
      return new Response(JSON.stringify({ error: 'deep monthly quota exceeded' }), {
        status: 429,
        headers,
      });
    if (deepRate === 'error' && ENFORCE_STORE)
      return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
        status: 503,
        headers,
      });
  } else if (effectivePlan === 'pro' && uid) {
    const dayPro = await rateCheck(`day:pro:flash:${uid}`, PRO_FLASH_DAY_LIMIT, RATE_WINDOW_DAY);
    if (dayPro === 'limited')
      return new Response(JSON.stringify({ error: 'daily quota exceeded' }), {
        status: 429,
        headers,
      });
    if (dayPro === 'error' && ENFORCE_STORE)
      return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
        status: 503,
        headers,
      });
  } else {
    const dayRate = await rateCheck(`day:ip:${ip}`, RATE_PER_DAY, RATE_WINDOW_DAY);
    if (dayRate === 'limited')
      return new Response(JSON.stringify({ error: 'daily quota exceeded' }), {
        status: 429,
        headers,
      });
    if (dayRate === 'error' && ENFORCE_STORE)
      return new Response(JSON.stringify({ error: 'rate limiter unavailable' }), {
        status: 503,
        headers,
      });
  }

  const { system, user } = buildPrompt(body);
  try {
    const text = await callProvider(provider, model, system, user, { deep: useDeep });
    if (cacheKey && text)
      await cachePut(cacheKey, body.game, body.profile?.level ?? 'beginner', text, provider);
    return new Response(JSON.stringify({ text, provider, plan: effectivePlan, depth }), {
      headers,
    });
  } catch (err) {
    // OWASP A09 / CodeQL js/stack-trace-exposure: クライアントへ message/stack を返さない。
    console.error('provider call failed', err instanceof Error ? err.name : 'error');
    return new Response(JSON.stringify({ error: 'upstream failed' }), {
      status: 502,
      headers,
    });
  }
});
