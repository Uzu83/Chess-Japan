import { afterEach, describe, expect, it, vi } from 'vitest';
import reviewSrc from '../ui/ReviewView.tsx?raw';

const SCRIPT_HINT = 'challenges.cloudflare.com/turnstile';

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
  document.querySelectorAll(`script[src*="${SCRIPT_HINT}"]`).forEach((el) => el.remove());
  document.querySelectorAll('[data-cj-turnstile]').forEach((el) => el.remove());
  document.getElementById('cj-turnstile-host')?.remove();
  delete window.turnstile;
});

async function loadTurnstile(siteKey: string) {
  vi.resetModules();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', siteKey);
  return import('./turnstile');
}

async function readyScriptAndTokenApi(siteKey = 'test-site-key') {
  let callback: ((token: string) => void) | undefined;
  const reset = vi.fn();
  const execute = vi.fn();
  const render = vi.fn((_el: string | HTMLElement, opts: Record<string, unknown>) => {
    callback = opts.callback as (token: string) => void;
    return 'wid';
  });
  window.turnstile = { render, execute, reset };

  const mod = await loadTurnstile(siteKey);
  mod.prefetchTurnstileScript();
  document.querySelector(`script[src*="${SCRIPT_HINT}"]`)!.dispatchEvent(new Event('load'));
  await Promise.resolve();
  return { ...mod, render, execute, reset, getCallback: () => callback };
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
    const { getTurnstileToken, getCallback } = await readyScriptAndTokenApi();

    const first = getTurnstileToken();
    const second = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(11_000);
    getCallback()?.('token-1');
    await expect(first).resolves.toBe('token-1');

    await vi.advanceTimersByTimeAsync(2_000);
    getCallback()?.('token-2');
    await expect(second).resolves.toBe('token-2');
    vi.useRealTimers();
  });

  it('時間切れ後も次のトークン取得が鎖で詰まらない', async () => {
    vi.useFakeTimers();
    const { getTurnstileToken, getCallback, reset } = await readyScriptAndTokenApi();

    const first = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(first).rejects.toThrow(/turnstile timeout/);
    // #93: アプリ側タイムアウトでは即 reset しない（表示中の挑戦を残す）
    expect(reset).not.toHaveBeenCalled();

    const second = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    // 再試行の execute 前にだけ reset する
    expect(reset).toHaveBeenCalledTimes(1);
    getCallback()?.('token-retry');
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

describe('setTurnstileMountHost（#72 / #93）', () => {
  it('render 先がパネルホストになる', async () => {
    const host = document.createElement('div');
    host.id = 'cj-turnstile-host';
    document.body.appendChild(host);
    const { setTurnstileMountHost, getTurnstileToken, render, TURNSTILE_HOST_ID } =
      await readyScriptAndTokenApi();
    expect(TURNSTILE_HOST_ID).toBe('cj-turnstile-host');
    setTurnstileMountHost(host);

    const pending = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(render).toHaveBeenCalled();
    const firstArgs = render.mock.calls[0] as unknown as [HTMLElement] | undefined;
    expect(firstArgs).toBeDefined();
    const mountEl = firstArgs![0];
    expect(host.contains(mountEl)).toBe(true);
    pending.catch(() => {});
    setTurnstileMountHost(null);
    host.remove();
  });

  it('同一 HTMLElement への再 set は tear-down しない（#93）', async () => {
    const host = document.createElement('div');
    host.id = 'cj-turnstile-host';
    document.body.appendChild(host);
    const { setTurnstileMountHost, getTurnstileToken, render, getCallback } =
      await readyScriptAndTokenApi();

    setTurnstileMountHost(host);
    const first = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);
    getCallback()?.('token-1');
    await expect(first).resolves.toBe('token-1');

    // 同じノードを再度渡しても widget を捨てない
    setTurnstileMountHost(host);
    expect(render).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-cj-turnstile]')).toBeTruthy();

    // Strict Mode 風: null → 同一ノード再登録でも widget を残す
    setTurnstileMountHost(null);
    expect(host.querySelector('[data-cj-turnstile]')).toBeTruthy();
    setTurnstileMountHost(host);
    expect(render).toHaveBeenCalledTimes(1);

    // 追問の 2 回目 execute も同じホスト上で完了できる
    const second = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);
    getCallback()?.('token-2');
    await expect(second).resolves.toBe('token-2');

    host.remove();
    setTurnstileMountHost(null);
  });

  it('初回 execute は reset せず、トークン消費後の再 execute だけ reset する（#93）', async () => {
    const { getTurnstileToken, getCallback, reset, execute } = await readyScriptAndTokenApi();

    const first = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    getCallback()?.('token-1');
    await expect(first).resolves.toBe('token-1');

    const second = getTurnstileToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
    getCallback()?.('token-2');
    await expect(second).resolves.toBe('token-2');
  });
});

describe('レビュー入場は挑戦を先回りしない（GPT 監査 P2）', () => {
  it('ReviewView は script 先読みだけ呼び、トークン先回りは呼ばない', () => {
    expect(reviewSrc).toContain('prefetchTurnstileScript()');
    expect(reviewSrc).not.toContain('prefetchTurnstileToken');
  });
});
