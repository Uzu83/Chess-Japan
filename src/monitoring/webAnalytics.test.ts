import { afterEach, describe, expect, it, vi } from 'vitest';
import headers from '../../public/_headers?raw';
import privacy from '../../public/privacy.html?raw';
import vercel from '../../vercel.json?raw';

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const TOKEN = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  document.querySelectorAll(`script[src="${BEACON_SRC}"]`).forEach((el) => el.remove());
});

async function load(token: string) {
  vi.resetModules();
  vi.stubEnv('VITE_CF_WEB_ANALYTICS_TOKEN', token);
  return import('./webAnalytics');
}

describe('mountWebAnalyticsIfConfigured', () => {
  it('トークン未設定ならビーコンを挿さない', async () => {
    const { mountWebAnalyticsIfConfigured } = await load('');
    mountWebAnalyticsIfConfigured();
    expect(document.querySelector(`script[src="${BEACON_SRC}"]`)).toBeNull();
  });

  it('引用符や短い値は挿さない', async () => {
    const { mountWebAnalyticsIfConfigured } = await load('"><script>');
    mountWebAnalyticsIfConfigured();
    expect(document.querySelector('script[data-cf-beacon]')).toBeNull();
  });

  it('32桁の公開トークンなら module ビーコンを1つだけ挿す', async () => {
    const { mountWebAnalyticsIfConfigured } = await load(TOKEN);
    mountWebAnalyticsIfConfigured();
    mountWebAnalyticsIfConfigured();
    const scripts = document.querySelectorAll(`script[src="${BEACON_SRC}"]`);
    expect(scripts).toHaveLength(1);
    const script = scripts[0] as HTMLScriptElement;
    expect(script.type).toBe('module');
    expect(JSON.parse(script.dataset.cfBeacon ?? '')).toEqual({ token: TOKEN, spa: true });
  });
});

describe('Web Analytics の許可', () => {
  it('Pages と Vercel の CSP がビーコンの取得と送信を許可する', () => {
    for (const text of [headers, vercel]) {
      expect(text).toContain('https://static.cloudflareinsights.com');
      expect(text).toContain('https://cloudflareinsights.com');
    }
  });

  it('プライバシーポリシーが匿名集計を説明し、導入予定のまま残さない', () => {
    expect(privacy).toContain('匿名のアクセス集計');
    expect(privacy).toContain('Cookie は使いません');
    expect(privacy).not.toContain('導入予定');
  });
});
