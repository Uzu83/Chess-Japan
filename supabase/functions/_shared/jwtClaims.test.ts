import { describe, expect, it } from 'vitest';
import { isJwtFresh, readJwtIssuedAt } from './jwtClaims.ts';

function fakeJwt(payload: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `hdr.${body}.sig`;
}

describe('readJwtIssuedAt / isJwtFresh', () => {
  it('reads iat', () => {
    expect(readJwtIssuedAt(fakeJwt({ iat: 1_700_000_000 }))).toBe(1_700_000_000);
  });

  it('rejects stale tokens', () => {
    const now = 1_700_000_600;
    const token = fakeJwt({ iat: 1_700_000_000 }); // 10 min old
    expect(isJwtFresh(token, 300, now)).toBe(false);
    expect(isJwtFresh(token, 900, now)).toBe(true);
  });

  it('rejects missing iat', () => {
    expect(isJwtFresh(fakeJwt({ sub: 'x' }), 300, 1_700_000_000)).toBe(false);
  });
});
