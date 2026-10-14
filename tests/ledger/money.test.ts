import { describe, expect, it } from 'vitest';
import { fromUnits, toUnits } from '../../src/ledger/money.js';

describe('money', () => {
  it('parses decimals into smallest units without floats', () => {
    expect(toUnits('1', 6)).toBe(1_000_000n);
    expect(toUnits('0.000001', 6)).toBe(1n);
    expect(toUnits('123456789.123456789123456789', 18)).toBe(123456789123456789123456789n);
    // 0.1 + 0.2 style errors are impossible: these are integers.
    expect(toUnits('0.1', 18) + toUnits('0.2', 18)).toBe(toUnits('0.3', 18));
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => toUnits('0.0000001', 6)).toThrow(/decimal places/);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1e6', '01', '1.', '.5', ' 1', 'NaN']) {
      expect(() => toUnits(bad, 6), bad).toThrow();
    }
  });

  it('formats back without trailing zeros', () => {
    expect(fromUnits(1_500_000n, 6)).toBe('1.5');
    expect(fromUnits(1n, 18)).toBe('0.000000000000000001');
    expect(fromUnits(0n, 6)).toBe('0');
    expect(fromUnits(-2_000_000n, 6)).toBe('-2');
  });
});
