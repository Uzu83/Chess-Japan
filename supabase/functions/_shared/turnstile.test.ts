/**
 * turnstile.test.ts — hostname 解決
 */
import { describe, expect, it } from 'vitest';
import { resolveTurnstileHostnames } from './turnstile';

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
