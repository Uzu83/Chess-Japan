import { describe, expect, it } from 'vitest';

/**
 * verifyStripeWebhook の複数 v1 受理は Web Crypto + 実 whsec が要るため、
 * ここではシグネチャパース相当の純ロジックを回帰固定する。
 */
function collectV1(sigHeader: string): { t?: string; v1: string[] } {
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of sigHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1);
    if (k === 't') t = v;
    if (k === 'v1' && v) v1.push(v);
  }
  return { t, v1 };
}

describe('Stripe-Signature multi v1 parse', () => {
  it('keeps all v1 values (rotation)', () => {
    const { t, v1 } = collectV1('t=1700000000,v1=aaa,v1=bbb');
    expect(t).toBe('1700000000');
    expect(v1).toEqual(['aaa', 'bbb']);
  });
});
