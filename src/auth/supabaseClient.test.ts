/*
 * supabaseClient.test.ts — auth 機能ゲーティングの回帰テスト
 *
 * ここで守りたい不変条件:
 *   1. VITE_AUTH_ENABLED='1' が無い限り isAuthConfigured() は false
 *      (= .env.local に URL/key があるだけではログイン UI が出ない。
 *       「ダッシュボード設定前の壊れたログインボタン」を本番に出さないための門)
 *   2. env はモジュールロード時でなく呼び出し時に読まれる
 *      (vi.stubEnv が効くこと自体がその証明。explain/client.ts の事故の再発防止)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasStoredSession, isAuthConfigured, isOAuthCallback } from './supabaseClient';

/*
 * jsdom の既定オリジン(about:blank)では localStorage が使えないことがあるため、
 * インメモリ実装を stubGlobal で差し込む(storage.test.ts と同じ流儀・同じ WHY)。
 */
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isAuthConfigured — 3条件ゲート', () => {
  it('何も設定されていなければ false', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.stubEnv('VITE_AUTH_ENABLED', '');
    expect(isAuthConfigured()).toBe(false);
  });

  it('URL/key があっても VITE_AUTH_ENABLED が無ければ false(壊れたボタン防止の門)', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('VITE_AUTH_ENABLED', '');
    expect(isAuthConfigured()).toBe(false);
  });

  it("VITE_AUTH_ENABLED は '1' ちょうどのみ有効('true' 等は無効)", () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('VITE_AUTH_ENABLED', 'true');
    expect(isAuthConfigured()).toBe(false);
    vi.stubEnv('VITE_AUTH_ENABLED', '1');
    expect(isAuthConfigured()).toBe(true);
  });

  it('フラグが立っていても URL か key が欠ければ false', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('VITE_AUTH_ENABLED', '1');
    expect(isAuthConfigured()).toBe(false);
  });
});

describe('hasStoredSession — SDK を読まずに永続セッションを検知', () => {
  it('localStorage が空なら false', () => {
    expect(hasStoredSession()).toBe(false);
  });

  it('sb-*-auth-token キーがあれば true、無関係キーでは false', () => {
    localStorage.setItem('cj:rating', '{}');
    expect(hasStoredSession()).toBe(false);
    localStorage.setItem('sb-abcdef-auth-token', '{"access_token":"x"}');
    expect(hasStoredSession()).toBe(true);
  });
});

describe('isOAuthCallback — PKCE 帰着の検知', () => {
  it('通常 URL では false(jsdom の初期 URL には ?code= が無い)', () => {
    expect(isOAuthCallback()).toBe(false);
  });
});
