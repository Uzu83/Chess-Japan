/**
 * billingIds.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isStripeCustomerId, isStripeEventId, isSupabaseUserId } from './billingIds';

describe('billingIds', () => {
  it('accepts uuid user ids', () => {
    expect(isSupabaseUserId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isSupabaseUserId('not-a-uuid')).toBe(false);
    expect(isSupabaseUserId("'; DROP TABLE profiles;--")).toBe(false);
  });
  it('accepts stripe ids', () => {
    expect(isStripeCustomerId('cus_NffrFeUfNV2Hib')).toBe(true);
    expect(isStripeCustomerId('cus_evil/../x')).toBe(false);
    expect(isStripeEventId('evt_1P2Q3R4S5T6U7V8W')).toBe(true);
  });
});
