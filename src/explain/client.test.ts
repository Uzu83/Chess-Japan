import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { isBackendConfigured, localExplanation, requestExplanation } from './client';
import type { ExplainRequest } from './client';

/*
 * Turnstile はモジュール定数で SITE_KEY を捕獲するため、.env.local にキーがあると
 * getTurnstileToken が script 待ちでハングする。API エラー試験では必ず no-op にする。
 */
vi.mock('./turnstile', () => ({
  getTurnstileToken: async () => null,
  isTurnstileEnabled: () => false,
}));

/*
 * env の明示 stub(テスト決定性):
 *   Vitest は Vite 経由で開発者の .env.local(VITE_SUPABASE_URL 等)も読み込む。
 *   このスイートは「バックエンド未設定」の挙動を検証するため、開発マシンに .env.local が
 *   あるだけで落ちる環境依存テストになっていた(実際に発生)。stubEnv で空に固定し、
 *   どの環境でも同じ前提で走るようにする。client.ts 側は env を呼び出し時に読む設計(対応済み)。
 */
beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', '');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const baseReq: ExplainRequest = {
  mode: 'explain',
  game: 'chess',
  context: {
    fenOrSfen: 'fen',
    movePlayed: 'a2a3',
    evalBefore: 50,
    evalAfter: -250,
    bestMove: 'e2e4',
    pv: ['e2e4'],
    quality: 'blunder',
  },
};

describe('explain client (バックエンド未設定)', () => {
  it('isBackendConfigured は false', () => {
    expect(isBackendConfigured()).toBe(false);
  });

  it('localExplanation は手の質と最善手を含む', () => {
    const text = localExplanation(baseReq);
    expect(text).toContain('悪手');
    expect(text).toContain('e2e4');
  });

  it('requestExplanation は未設定時ローカル解説にフォールバック', async () => {
    const text = await requestExplanation(baseReq);
    expect(text).toContain('悪手');
  });

  it('followup はローカル応答を返す', () => {
    const text = localExplanation({ ...baseReq, mode: 'followup', question: 'どういうこと?' });
    expect(text).toContain('どういうこと?');
  });
});

describe('explain client (API エラー)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('402 deep は日本語メッセージで throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'pro required for deep explain' }, { status: 402 })),
    );
    await expect(requestExplanation({ ...baseReq, depth: 'deep' })).rejects.toThrow(/Pro/);
  });

  it('429 日次枠は日本語メッセージで throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'daily quota exceeded' }, { status: 429 })),
    );
    await expect(requestExplanation(baseReq)).rejects.toThrow(/本日/);
  });
});
