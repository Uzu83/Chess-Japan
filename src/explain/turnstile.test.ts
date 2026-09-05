import { afterEach, describe, expect, it, vi } from 'vitest';
import reviewSrc from '../ui/ReviewView.tsx?raw';

const SCRIPT_HINT = 'challenges.cloudflare.com/turnstile';

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
  document.querySelectorAll(`script[src*="${SCRIPT_HINT}"]`).forEach((el) => el.remove());
  delete window.turnstile;
});

async function loadTurnstile(siteKey: string) {
  vi.resetModules();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', siteKey);
  return import('./turnstile');
}

describe('prefetchTurnstileScript', () => {
  it('キー無しなら script を挿さない', async () => {
    const { prefetchTurnstileScript } = await loadTurnstile('');
    prefetchTurnstileScript();
    expect(document.querySelector(`script[src*="${SCRIPT_HINT}"]`)).toBeNull();
  });

  it('キーありなら script だけ挿し、挑戦は走らせない', async () => {
    const execute = vi.fn();
    const render = vi.fn(() => 'wid');
    window.turnstile = { render, execute, reset: vi.fn() };

    const { prefetchTurnstileScript, takeReadyTurnstileToken } =
      await loadTurnstile('test-site-key');
    prefetchTurnstileScript();

    expect(document.querySelector(`script[src*="${SCRIPT_HINT}"]`)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(takeReadyTurnstileToken()).toBeNull();
  });

  it('script 読み込み失敗後も getTurnstileToken が同じ rejection を使い回さない', async () => {
    const { prefetchTurnstileScript, getTurnstileToken } = await loadTurnstile('test-site-key');
    prefetchTurnstileScript();
    const first = document.querySelector(`script[src*="${SCRIPT_HINT}"]`);
    expect(first).toBeTruthy();
    first!.dispatchEvent(new Event('error'));
    await Promise.resolve();

    const pending = getTurnstileToken();
    const raced = await Promise.race([
      pending.then(
        () => 'resolved',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('pending'), 50);
      }),
    ]);
    expect(raced).toBe('pending');
    pending.catch(() => {});
  });

  it('待ち行列の待機時間はトークン取得のタイムアウトに含めない', async () => {
    vi.useFakeTimers();
    let callback: ((token: string) => void) | undefined;
    window.turnstile = {
      render: (_el, opts: Record<string, unknown>) => {
        callback = opts.callback as (token: string) => void;
        return 'wid';
      },
      execute: vi.fn(),
      reset: vi.fn(),
    };

    const { getTurnstileToken, prefetchTurnstileScript } = await loadTurnstile('test-site-key');
    prefetchTurnstileScript();
    document.querySelector(`script[src*="${SCRIPT_HINT}"]`)!.dispatchEvent(new Event('load'));
    await Promise.resolve();

    const first = getTurnstileToken();
    const second = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(11_000);
    callback?.('token-1');
    await expect(first).resolves.toBe('token-1');

    await vi.advanceTimersByTimeAsync(2_000);
    callback?.('token-2');
    await expect(second).resolves.toBe('token-2');
    vi.useRealTimers();
  });

  it('時間切れ後も次のトークン取得が鎖で詰まらない', async () => {
    vi.useFakeTimers();
    let callback: ((token: string) => void) | undefined;
    window.turnstile = {
      render: (_el, opts: Record<string, unknown>) => {
        callback = opts.callback as (token: string) => void;
        return 'wid';
      },
      execute: vi.fn(),
      reset: vi.fn(),
    };

    const { getTurnstileToken, prefetchTurnstileScript } = await loadTurnstile('test-site-key');
    prefetchTurnstileScript();
    document.querySelector(`script[src*="${SCRIPT_HINT}"]`)!.dispatchEvent(new Event('load'));
    await Promise.resolve();

    const first = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(first).rejects.toThrow(/turnstile timeout/);

    const second = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    callback?.('token-retry');
    await expect(second).resolves.toBe('token-retry');
    vi.useRealTimers();
  });

  it('setTurnstileMountHost すると render 先がパネルホストになる（#72）', async () => {
    const host = document.createElement('div');
    host.id = 'cj-turnstile-host';
    document.body.appendChild(host);
    const render = vi.fn(() => 'wid');
    window.turnstile = { render, execute: vi.fn(), reset: vi.fn() };

    const { setTurnstileMountHost, getTurnstileToken, prefetchTurnstileScript, TURNSTILE_HOST_ID } =
      await loadTurnstile('test-site-key');
    expect(TURNSTILE_HOST_ID).toBe('cj-turnstile-host');
    setTurnstileMountHost(host);
    prefetchTurnstileScript();
    document.querySelector(`script[src*="${SCRIPT_HINT}"]`)!.dispatchEvent(new Event('load'));
    await Promise.resolve();

    const pending = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(render).toHaveBeenCalled();
    // Mock の calls は引数タプルを [] と推論しうるため、unknown 経由で取り出す。
    const firstArgs = render.mock.calls[0] as unknown as [HTMLElement] | undefined;
    expect(firstArgs).toBeDefined();
    const mountEl = firstArgs![0];
    expect(host.contains(mountEl)).toBe(true);
    pending.catch(() => {});
    setTurnstileMountHost(null);
    host.remove();
  });
});

describe('レビュー入場は挑戦を先回りしない（GPT 監査 P2）', () => {
  it('ReviewView は script 先読みだけ呼び、トークン先回りは呼ばない', () => {
    expect(reviewSrc).toContain('prefetchTurnstileScript()');
    expect(reviewSrc).not.toContain('prefetchTurnstileToken');
  });
});
