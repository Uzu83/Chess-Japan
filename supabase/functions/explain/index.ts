// Supabase Edge Function: 解説/対話 LLM プロキシ
//
// 役割:
//   - APIキーをサーバー側に秘匿し、フロントから安全に LLM を呼ぶ
//   - レート制限 / 入力サイズ上限でコスト爆発を防ぐ(収益ゼロ前提の最重要対策)
//   - プロバイダ抽象(既定 Grok、比較用に Gemini)
//   - 解説(explain) と 追問(followup) の2モード
//   - UserKnowledgeProfile(既知/未知用語)をプロンプトへ注入し半パーソナライズ
//
// 注意: これは Phase 0 の骨組み。レート制限はインメモリの簡易版。
//       本番では Supabase テーブル / Upstash などの永続ストアに置き換える。
//
// デプロイ: supabase functions deploy explain
// シークレット: supabase secrets set XAI_API_KEY=... GEMINI_API_KEY=... LLM_PROVIDER=grok

// deno-lint-ignore-file no-explicit-any

const MAX_BODY_BYTES = 16 * 1024; // 16KB: 巨大入力を拒否
const RATE_LIMIT = { windowMs: 60_000, max: 20 }; // 1分あたり20リクエスト/IP

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map((s) => s.trim());

type Mode = 'explain' | 'followup';

interface KnowledgeProfile {
  known: string[]; // 既知の用語 (例: ["pin", "fork"])
  unknown: string[]; // 未知の用語
  level?: 'beginner' | 'intermediate' | 'advanced';
}

interface RequestBody {
  mode: Mode;
  game: 'chess' | 'shogi';
  // エンジンが出した数値事実(フロントの AnalysisService/MoveClassifier が生成)
  context: {
    fenOrSfen: string;
    movePlayed?: string;
    evalBefore?: number;
    evalAfter?: number;
    bestMove?: string;
    pv?: string[];
    quality?: string; // best/good/inaccuracy/mistake/blunder
  };
  question?: string; // followup 時のユーザーの質問
  history?: { role: 'user' | 'assistant'; content: string }[];
  profile?: KnowledgeProfile;
}

// ---- 簡易インメモリ・レートリミッタ(インスタンス単位) ----
const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_LIMIT.max;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow =
    ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin))
      ? (origin ?? '*')
      : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Content-Type': 'application/json',
  };
}

function buildPrompt(body: RequestBody): { system: string; user: string } {
  const { profile, context, mode, question } = body;
  const level = profile?.level ?? 'beginner';
  const known = profile?.known?.length ? profile.known.join(', ') : 'なし';
  const unknown = profile?.unknown?.length ? profile.unknown.join(', ') : '不明';

  const system = [
    'あなたはチェス/将棋の親切な解説者です。',
    '与えられた「エンジンの数値事実」だけを根拠に解説してください。評価値や最善手を勝手に創作しないこと。',
    `対象レベル: ${level}。`,
    `ユーザーが既に理解している用語: ${known}。これらは説明を省き簡潔に使ってよい。`,
    `ユーザーが知らない可能性が高い用語: ${unknown}。これらを使うときは一言で補足する。`,
    '日本語で、簡潔かつ具体的に。',
  ].join('\n');

  const facts = JSON.stringify(context, null, 2);
  const user =
    mode === 'followup'
      ? `直前の解説に対する質問:「${question ?? ''}」\n局面の事実:\n${facts}\nわかりやすく答えてください。`
      : `次の局面と指し手を1手として解説してください。\n事実:\n${facts}`;

  return { system, user };
}

async function callGrok(system: string, user: string): Promise<string> {
  const key = Deno.env.get('XAI_API_KEY');
  if (!key) throw new Error('XAI_API_KEY 未設定');
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: Deno.env.get('GROK_MODEL') ?? 'grok-4.1-fast',
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

async function callGemini(system: string, user: string): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 未設定');
  const model = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash-lite';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST')
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers,
    });

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('cf-connecting-ip') ??
    'unknown';
  if (rateLimited(ip))
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES)
    return new Response(JSON.stringify({ error: 'payload too large' }), {
      status: 413,
      headers,
    });

  let body: RequestBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers });
  }

  if (!body?.context?.fenOrSfen || (body.mode !== 'explain' && body.mode !== 'followup'))
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400, headers });

  const provider = Deno.env.get('LLM_PROVIDER') ?? 'grok';
  const { system, user } = buildPrompt(body);

  try {
    const text =
      provider === 'gemini' ? await callGemini(system, user) : await callGrok(system, user);
    return new Response(JSON.stringify({ text, provider }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 502,
      headers,
    });
  }
});
