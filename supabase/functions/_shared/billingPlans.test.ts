/**
 * billingPlans.test.ts — entitlement / depth 解決
 */
import { describe, expect, it } from 'vitest';
import {
  parsePlan,
  parseStripeStatus,
  resolveEntitlement,
  shouldUseDeepModel,
} from './billingPlans';

describe('resolveEntitlement', () => {
  it('pro + active → effective pro', () => {
    expect(resolveEntitlement('pro', 'active').effectivePlan).toBe('pro');
  });
  it('pro + past_due → effective free（コスト防衛）', () => {
    expect(resolveEntitlement('pro', 'past_due').effectivePlan).toBe('free');
  });
  it('free + active → free', () => {
    expect(resolveEntitlement('free', 'active').effectivePlan).toBe('free');
  });
});

describe('shouldUseDeepModel', () => {
  it('only pro+deep', () => {
    expect(shouldUseDeepModel('pro', 'deep')).toBe(true);
    expect(shouldUseDeepModel('pro', 'standard')).toBe(false);
    expect(shouldUseDeepModel('free', 'deep')).toBe(false);
  });
});

describe('parsers', () => {
  it('parsePlan defaults to free', () => {
    expect(parsePlan('pro')).toBe('pro');
    expect(parsePlan('nope')).toBe('free');
    expect(parsePlan(null)).toBe('free');
  });
  it('parseStripeStatus', () => {
    expect(parseStripeStatus('past_due')).toBe('past_due');
    expect(parseStripeStatus('x')).toBe('none');
  });
});
