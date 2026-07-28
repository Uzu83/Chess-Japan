/**
 * billingSite.test.ts — オープンリダイレクト防止
 */
import { describe, expect, it } from 'vitest';
import { resolveBillingSiteUrl } from './billingSite';

describe('resolveBillingSiteUrl', () => {
  it('prefers SITE_URL https', () => {
    expect(
      resolveBillingSiteUrl({
        siteUrlEnv: 'https://chess-japan.pages.dev/',
        allowedOriginsEnv: 'https://evil.example',
        isHosted: true,
      }),
    ).toBe('https://chess-japan.pages.dev');
  });

  it('rejects http SITE_URL when hosted', () => {
    expect(
      resolveBillingSiteUrl({
        siteUrlEnv: 'http://chess-japan.pages.dev',
        allowedOriginsEnv: '',
        isHosted: true,
      }),
    ).toBeNull();
  });

  it('ignores wildcard ALLOWED_ORIGINS', () => {
    expect(
      resolveBillingSiteUrl({
        siteUrlEnv: '',
        allowedOriginsEnv: '*',
        isHosted: true,
      }),
    ).toBeNull();
  });

  it('allows localhost only when not hosted', () => {
    expect(
      resolveBillingSiteUrl({
        siteUrlEnv: '',
        allowedOriginsEnv: 'http://localhost:5173',
        isHosted: false,
      }),
    ).toBe('http://localhost:5173');
    expect(
      resolveBillingSiteUrl({
        siteUrlEnv: '',
        allowedOriginsEnv: 'http://localhost:5173',
        isHosted: true,
      }),
    ).toBeNull();
  });
});
