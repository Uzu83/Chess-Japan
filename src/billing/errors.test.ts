import { formatBillingApiError, formatBillingNetworkError } from './errors';

describe('formatBillingApiError', () => {
  it('maps known body errors', () => {
    expect(formatBillingApiError(409, 'already subscribed')).toContain('すでに');
    expect(formatBillingApiError(401, 'unauthorized')).toContain('ログイン');
    expect(formatBillingApiError(403, 'email not confirmed')).toContain('メール');
    expect(formatBillingApiError(502, 'portal unavailable')).toContain('サブスク管理');
    expect(formatBillingApiError(502, 'checkout unavailable')).toContain('決済ページ');
  });

  it('falls back by status', () => {
    expect(formatBillingApiError(429)).toContain('集中');
    expect(formatBillingApiError(503)).toContain('一時的');
  });
});

describe('formatBillingNetworkError', () => {
  it('maps Failed to fetch to a Japanese retry hint', () => {
    expect(formatBillingNetworkError(new TypeError('Failed to fetch'))).toContain('接続できません');
  });
});
