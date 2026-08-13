import { afterEach, describe, expect, it, vi } from 'vitest';
import reviewSrc from '../ui/ReviewView.tsx?raw';

const SCRIPT_HINT = 'challenges.cloudflare.com/turnstile';

afterEach(() => {
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
});

describe('レビュー入場は挑戦を先回りしない（GPT 監査 P2）', () => {
  it('ReviewView は script 先読みだけ呼び、トークン先回りは呼ばない', () => {
    expect(reviewSrc).toContain('prefetchTurnstileScript()');
    expect(reviewSrc).not.toContain('prefetchTurnstileToken');
  });
});
