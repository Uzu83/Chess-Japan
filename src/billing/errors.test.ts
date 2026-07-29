import { formatBillingApiError } from './errors';

describe('formatBillingApiError', () => {
  it('maps known body errors', () => {
    expect(formatBillingApiError(409, 'already subscribed')).toContain('すでに');
    expect(formatBillingApiError(401, 'unauthorized')).toContain('ログイン');
    expect(formatBillingApiError(403, 'email not confirmed')).toContain('メール');
  });

  it('falls back by status', () => {
    expect(formatBillingApiError(429)).toContain('集中');
    expect(formatBillingApiError(503)).toContain('一時的');
  });
});
