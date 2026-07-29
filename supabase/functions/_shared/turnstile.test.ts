/**
 * turnstile.test.ts — hostname 解決
 */
import { describe, expect, it } from 'vitest';
import { clientIp, resolveTurnstileHostnames } from './turnstile';

describe('resolveTurnstileHostnames', () => {
  it('prefers explicit TURNSTILE_ALLOWED_HOSTNAMES', () => {
    expect(resolveTurnstileHostnames('chess-japan.pages.dev', 'https://evil.example')).toEqual([
      'chess-japan.pages.dev',
    ]);
  });
  it('derives from ALLOWED_ORIGINS', () => {
    expect(
      resolveTurnstileHostnames('', 'https://chess-japan.pages.dev,http://localhost:5173'),
    ).toEqual(['chess-japan.pages.dev', 'localhost']);
  });
  it('ignores wildcard', () => {
    expect(resolveTurnstileHostnames('', '*')).toEqual([]);
  });
});

describe('clientIp', () => {
  it('falls through empty cf-connecting-ip to XFF', () => {
    const req = new Request('https://example.test/', {
      headers: { 'cf-connecting-ip': '', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    expect(clientIp(req)).toBe('203.0.113.9');
  });
  it('uses unknown when all IP headers empty', () => {
    const req = new Request('https://example.test/', {
      headers: { 'cf-connecting-ip': '', 'x-forwarded-for': '' },
    });
    expect(clientIp(req)).toBe('unknown');
  });
});

// verifyTurnstileToken: secret あり + hostnames 空は fail-closed（結合は Edge 側）。
