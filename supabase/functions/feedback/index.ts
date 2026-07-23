// Supabase Edge Function: ユーザーフィードバック → GitHub Issue（v1）
//
// 役割:
//   - アプリ内フィードバックを受け取り、公開 GitHub Issue を作成する
//   - explain と同型のコスト/濫用防衛（CORS / body 上限 / Turnstile / rate_check fail-closed）
//   - Cloud Agent / draft PR は v2（本 Function は Issue 起票のみ）
//
// 秘密（Supabase secrets。VITE_ に出さない）:
//   GITHUB_FEEDBACK_TOKEN … fine-grained PAT（対象1リポ・issues: write）
//   GITHUB_FEEDBACK_REPO … owner/name（例 Uzu83/Chess-Japan）
//   FEEDBACK_FALLBACK_URL … 超過/障害時に返す Google Form 等（任意だが本番推奨）
//   TURNSTILE_SECRET / ALLOWED_ORIGINS … explain と共用可
//   FEEDBACK_RATE_PER_MIN / FEEDBACK_RATE_PER_DAY_IP / FEEDBACK_RATE_GLOBAL_DAY … 上書き任意
//
// デプロイ: supabase functions deploy feedback

import {
  FEEDBACK_MAX_BODY_BYTES,
  buildFeedbackIssueBody,
  buildFeedbackIssueTitle,
  validateFeedbackBody,
} from '../_shared/feedbackValidate.ts';
import { byteLengthOf as utf8Len } from '../_shared/validate.ts';

// 専用レート（explain の RATE_* と分離。フィードバックは LLM 課金ではないが Issue 洪水対策）。
const RATE_PER_MIN = Number(Deno.env.get('FEEDBACK_RATE_PER_MIN') ?? '5');
const RATE_PER_DAY_IP = Number(Deno.env.get('FEEDBACK_RATE_PER_DAY_IP') ?? '20');
const RATE_GLOBAL_DAY = Number(Deno.env.get('FEEDBACK_RATE_GLOBAL_DAY') ?? '50');

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const IS_HOSTED = Boolean(Deno.env.get('DENO_DEPLOYMENT_ID'));

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const STORE_READY = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET');
const GITHUB_TOKEN = Deno.env.get('GITHUB_FEEDBACK_TOKEN');
const GITHUB_REPO = Deno.env.get('GITHUB_FEEDBACK_REPO');
const FALLBACK_URL = Deno.env.get('FEEDBACK_FALLBACK_URL') ?? '';

// 本番(hosted)ではストア・Turnstile・GitHub 設定を必須（fail-closed）。
// GitHub トークンがある環境も「本物の Issue を作れる」ので同様に防衛必須。
const HAS_GITHUB = Boolean(GITHUB_TOKEN && GITHUB_REPO);
const ENFORCE_STORE = IS_HOSTED || HAS_GITHUB;
const ENFORCE_TURNSTILE = IS_HOSTED || HAS_GITHUB;
const ENFORCE_GITHUB = IS_HOSTED;

function resolveCors(origin: string | null): { allowed: boolean; headers: Record<string, string> } {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-turnstile-token',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  if (ALLOWED_ORIGINS.includes('*')) {
    return { allowed: true, headers: { ...base, 'Access-Control-Allow-Origin': origin ?? '*' } };
  }
  if (ALLOWED_ORIGINS.length === 0) {
    if (!IS_HOSTED)
      return { allowed: true, headers: { ...base, 'Access-Control-Allow-Origin': origin ?? '*' } };
    return { allowed: false, headers: { ...base, 'Access-Control-Allow-Origin': 'null' } };
  }
  if (origin && ALLOWED_ORIGINS.includes(origin))
    return { allowed: true, headers: { ...base, 'Access-Control-Allow-Origin': origin } };
  if (!origin) return { allowed: true, headers: base };
  return { allowed: false, headers: { ...base, 'Access-Control-Allow-Origin': 'null' } };
}

async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) {
    const t = await req.text();
    return utf8Len(t) > max ? null : t;
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

function sbHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

type RateOutcome = 'ok' | 'limited' | 'error';

async function rateCheck(key: string, limit: number, windowSeconds: number): Promise<RateOutcome> {
  if (!STORE_READY) return 'ok';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rate_check`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: windowSeconds }),
    });
    if (!res.ok) return 'error';
    const allowed = await res.json();
    return allowed === true ? 'ok' : 'limited';
  } catch {
    return 'error';
  }
}

async function verifyTurnstile(token: string | null, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append('secret', TURNSTILE_SECRET);
    form.append('response', token);
    if (ip && ip !== 'unknown') form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

function clientIp(req: Request): string {
  // explain と同じ: 補助用。硬い防壁は Turnstile。
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function withFallback(body: Record<string, unknown>): Record<string, unknown> {
  if (FALLBACK_URL) return { ...body, fallbackUrl: FALLBACK_URL };
  return body;
}

async function createGitHubIssue(
  title: string,
  body: string,
): Promise<{ ok: true; issueUrl: string } | { ok: false; error: string }> {
  const [owner, repo] = (GITHUB_REPO as string).split('/');
  if (!owner || !repo) return { ok: false, error: 'github repo misconfigured' };
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'chess-japan-feedback',
      },
      body: JSON.stringify({
        title,
        body,
        labels: ['feedback'],
      }),
    });
    if (!res.ok) {
      // labels 未作成で 422 のときは labels 無しで再試行（運用初期の摩擦を下げる）。
      if (res.status === 422) {
        const retry = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'chess-japan-feedback',
          },
          body: JSON.stringify({ title, body }),
        });
        if (!retry.ok) {
          console.error(`github issue create failed: ${retry.status}`);
          return { ok: false, error: 'github issue create failed' };
        }
        const data = (await retry.json()) as { html_url?: string };
        if (!data.html_url) return { ok: false, error: 'github issue create failed' };
        return { ok: true, issueUrl: data.html_url };
      }
      console.error(`github issue create failed: ${res.status}`);
      return { ok: false, error: 'github issue create failed' };
    }
    const data = (await res.json()) as { html_url?: string };
    if (!data.html_url) return { ok: false, error: 'github issue create failed' };
    return { ok: true, issueUrl: data.html_url };
  } catch (err) {
    console.error('github issue create error', err);
    return { ok: false, error: 'github issue create failed' };
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = resolveCors(origin);
  const headers = cors.headers;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (!cors.allowed) {
    return jsonResponse(403, { ok: false, error: 'origin not allowed' }, headers);
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method not allowed' }, headers);
  }

  if (ENFORCE_STORE && !STORE_READY) {
    return jsonResponse(503, withFallback({ ok: false, error: 'service unavailable' }), headers);
  }
  if (ENFORCE_TURNSTILE && !TURNSTILE_SECRET) {
    return jsonResponse(
      503,
      withFallback({ ok: false, error: 'bot protection required' }),
      headers,
    );
  }
  if (ENFORCE_GITHUB && !HAS_GITHUB) {
    return jsonResponse(
      503,
      withFallback({ ok: false, error: 'feedback ingest unavailable' }),
      headers,
    );
  }
  // ローカルで GitHub 未設定なら起票できないので明示エラー（Form へ誘導）。
  if (!HAS_GITHUB) {
    return jsonResponse(
      503,
      withFallback({ ok: false, error: 'feedback ingest unavailable' }),
      headers,
    );
  }

  const ip = clientIp(req);
  if (!(await verifyTurnstile(req.headers.get('x-turnstile-token'), ip))) {
    return jsonResponse(403, withFallback({ ok: false, error: 'turnstile failed' }), headers);
  }

  // レート: 分 / 日(IP) / 日(グローバル)。キー名前空間 fb: で explain と分離。
  const min = await rateCheck(`fb:min:ip:${ip}`, RATE_PER_MIN, 60);
  if (min === 'limited')
    return jsonResponse(429, withFallback({ ok: false, error: 'rate limited' }), headers);
  if (min === 'error' && ENFORCE_STORE)
    return jsonResponse(
      503,
      withFallback({ ok: false, error: 'rate limiter unavailable' }),
      headers,
    );

  // 分/日(IP) は洪水防壁として早期。グローバル日次枠は検証成功後のみ消費
  // （Codex cost cycle-22: 不正 JSON で共有枠を枯らさない）。
  const dayIp = await rateCheck(`fb:day:ip:${ip}`, RATE_PER_DAY_IP, 86400);
  if (dayIp === 'limited')
    return jsonResponse(429, withFallback({ ok: false, error: 'daily quota exceeded' }), headers);
  if (dayIp === 'error' && ENFORCE_STORE)
    return jsonResponse(
      503,
      withFallback({ ok: false, error: 'rate limiter unavailable' }),
      headers,
    );

  const declaredLen = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > FEEDBACK_MAX_BODY_BYTES) {
    return jsonResponse(413, withFallback({ ok: false, error: 'payload too large' }), headers);
  }
  const raw = await readBodyCapped(req, FEEDBACK_MAX_BODY_BYTES);
  if (raw === null) {
    return jsonResponse(413, withFallback({ ok: false, error: 'payload too large' }), headers);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse(400, withFallback({ ok: false, error: 'invalid json' }), headers);
  }

  const validated = validateFeedbackBody(parsed);
  if (!validated.ok) {
    return jsonResponse(400, withFallback({ ok: false, error: validated.error }), headers);
  }

  const dayGlobal = await rateCheck('fb:day:global', RATE_GLOBAL_DAY, 86400);
  if (dayGlobal === 'limited')
    return jsonResponse(
      429,
      withFallback({ ok: false, error: 'global daily quota exceeded' }),
      headers,
    );
  if (dayGlobal === 'error' && ENFORCE_STORE)
    return jsonResponse(
      503,
      withFallback({ ok: false, error: 'rate limiter unavailable' }),
      headers,
    );

  const receivedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = buildFeedbackIssueTitle(validated.value.kind, receivedAt);
  const issueBody = buildFeedbackIssueBody(validated.value, receivedAt);

  // 念のため本文サイズもガード（符号化後）。
  if (utf8Len(issueBody) > 60_000) {
    return jsonResponse(413, withFallback({ ok: false, error: 'payload too large' }), headers);
  }

  const created = await createGitHubIssue(title, issueBody);
  if (!created.ok) {
    return jsonResponse(502, withFallback({ ok: false, error: created.error }), headers);
  }

  return jsonResponse(200, { ok: true, issueUrl: created.issueUrl }, headers);
});
