import { formatExplainApiError } from './errors';

describe('formatExplainApiError', () => {
  it('maps known body errors', () => {
    expect(formatExplainApiError(402, 'pro required for deep explain')).toContain('Pro');
    expect(formatExplainApiError(429, 'daily quota exceeded')).toContain('本日');
    expect(formatExplainApiError(429, 'deep monthly quota exceeded')).toContain('深掘り');
  });

  it('falls back by status when body missing', () => {
    expect(formatExplainApiError(402)).toContain('Pro');
    expect(formatExplainApiError(429)).toContain('集中');
    expect(formatExplainApiError(503)).toContain('一時的');
  });

  it('passes through short unknown body', () => {
    expect(formatExplainApiError(400, 'invalid fen')).toBe('invalid fen');
  });
});
