// Supabase Edge Function: PvP 着手（chess.js 検証 → service_role 原子 commit）
//
// 契約（A0）:
//   - Bearer JWT → uid。body の user_id/color は受け取らない
//   - 棋理検証は Edge、書き込みは pvp_apply_move（service_role のみ）
//   - Turnstile なし（LLM 課金経路ではない）。rate_check は pvp: 名前空間
//
// デプロイ: supabase functions deploy pvp
// 本番順: migration 0010 → 旧 RPC 死確認 → 本 Function → 新 client → VITE_PVP_ENABLED=1

import { applySan } from '../_shared/chessPvp.ts';

const RATE_PER_MIN = Number(Deno.env.get('PVP_RATE_PER_MIN') ?? '30');
const MAX_BODY = 2048;

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const IS_HOSTED = Boolean(Deno.env.get('DENO_DEPLOYMENT_ID'));

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const STORE_READY = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

function resolveCors(origin: string | null): { allowed: boolean; headers: Record<string, string> } {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
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

function sbServiceHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) {
    const t = await req.text();
    return new TextEncoder().encode(t).byteLength > max ? null : t;
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

async function rateCheck(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<'ok' | 'limited' | 'error'> {
  if (!STORE_READY) return 'ok';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rate_check`, {
      method: 'POST',
      headers: sbServiceHeaders(),
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: windowSeconds }),
    });
    if (!res.ok) return 'error';
    const allowed = (await res.json()) as boolean;
    return allowed ? 'ok' : 'limited';
  } catch {
    return 'error';
  }
}

async function getUser(req: Request): Promise<{ id: string; emailConfirmed: boolean } | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token || !SUPABASE_URL) return null;
  const key = ANON_KEY || SERVICE_ROLE_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; email_confirmed_at?: string | null };
    if (typeof body.id !== 'string') return null;
    return { id: body.id, emailConfirmed: Boolean(body.email_confirmed_at) };
  } catch {
    return null;
  }
}

async function fetchRoom(roomId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pvp_rooms?id=eq.${encodeURIComponent(roomId)}&select=*`,
    { headers: sbServiceHeaders() },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = resolveCors(origin);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers });
  }
  if (!cors.allowed) {
    return new Response(JSON.stringify({ error: 'origin not allowed' }), {
      status: 403,
      headers: cors.headers,
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: cors.headers,
    });
  }
  if (!STORE_READY) {
    return new Response(JSON.stringify({ error: 'store not configured' }), {
      status: 503,
      headers: cors.headers,
    });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: cors.headers,
    });
  }
  if (!user.emailConfirmed) {
    return new Response(JSON.stringify({ error: 'email not confirmed' }), {
      status: 403,
      headers: cors.headers,
    });
  }
  const uid = user.id;

  const rate = await rateCheck(`pvp:move:${uid}`, RATE_PER_MIN, 60);
  if (rate === 'limited') {
    return new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: cors.headers,
    });
  }
  if (rate === 'error' && IS_HOSTED) {
    return new Response(JSON.stringify({ error: 'rate check failed' }), {
      status: 503,
      headers: cors.headers,
    });
  }

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY) {
    return new Response(JSON.stringify({ error: 'body too large' }), {
      status: 413,
      headers: cors.headers,
    });
  }

  const raw = await readBodyCapped(req, MAX_BODY);
  if (raw === null) {
    return new Response(JSON.stringify({ error: 'body too large' }), {
      status: 413,
      headers: cors.headers,
    });
  }

  let body: { roomId?: unknown; san?: unknown };
  try {
    body = JSON.parse(raw) as { roomId?: unknown; san?: unknown };
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: cors.headers,
    });
  }

  const roomId = typeof body.roomId === 'string' ? body.roomId : '';
  const san = typeof body.san === 'string' ? body.san : '';
  if (!roomId || !/^[0-9a-f-]{36}$/i.test(roomId)) {
    return new Response(JSON.stringify({ error: 'invalid roomId' }), {
      status: 400,
      headers: cors.headers,
    });
  }
  if (!san || san.length < 2 || san.length > 16) {
    return new Response(JSON.stringify({ error: 'invalid san' }), {
      status: 400,
      headers: cors.headers,
    });
  }

  const room = await fetchRoom(roomId);
  // WHY 参加者判定を status 検査より先にするか（Codex authz cycle-11 F001）:
  //   非参加者に 404/409/403 の差を返すと部屋の存在・進行状態がオラクルになる。
  //   行なしと非参加者は同一 404 に合流させる。
  const white = (room?.['white_user_id'] as string | null) ?? null;
  const black = (room?.['black_user_id'] as string | null) ?? null;
  if (!room || (uid !== white && uid !== black)) {
    return new Response(JSON.stringify({ error: 'room not found' }), {
      status: 404,
      headers: cors.headers,
    });
  }
  if (room['status'] !== 'active') {
    return new Response(JSON.stringify({ error: 'room not active' }), {
      status: 409,
      headers: cors.headers,
    });
  }

  const movesRaw = room['moves'];
  const existing: string[] = Array.isArray(movesRaw)
    ? (movesRaw as unknown[]).map((m) => String(m))
    : [];
  const myColor = uid === white ? 'white' : 'black';
  const turn = existing.length % 2 === 0 ? 'white' : 'black';
  if (myColor !== turn) {
    return new Response(JSON.stringify({ error: 'not your turn' }), {
      status: 409,
      headers: cors.headers,
    });
  }

  const applied = applySan(existing, san);
  if (!applied.ok) {
    return new Response(JSON.stringify({ error: applied.error }), {
      status: 400,
      headers: cors.headers,
    });
  }

  const lastSan = applied.sans[applied.sans.length - 1]!;
  const finish = applied.outcome.over
    ? {
        p_result: applied.outcome.result,
        p_winner_color: applied.outcome.winner,
        p_finish_reason: applied.outcome.reason,
      }
    : {
        p_result: '*',
        p_winner_color: null,
        p_finish_reason: null,
      };

  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pvp_apply_move`, {
    method: 'POST',
    headers: sbServiceHeaders(),
    body: JSON.stringify({
      p_room_id: roomId,
      p_actor: uid,
      p_san: lastSan,
      p_fen: applied.fen,
      p_result: finish.p_result,
      p_winner_color: finish.p_winner_color,
      p_finish_reason: finish.p_finish_reason,
      p_expected_move_count: existing.length,
    }),
  });

  if (!rpc.ok) {
    const errText = await rpc.text();
    return new Response(JSON.stringify({ error: errText || 'apply failed' }), {
      status: rpc.status === 409 ? 409 : 400,
      headers: cors.headers,
    });
  }

  const updated = await rpc.json();
  return new Response(JSON.stringify({ room: updated }), {
    status: 200,
    headers: cors.headers,
  });
});
