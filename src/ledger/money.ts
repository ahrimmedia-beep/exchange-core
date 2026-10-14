/**
 * Money helpers. Every amount in this codebase is a bigint in the asset's smallest unit
 * (wei for ETH, 1e-6 for USDT). Decimal strings only exist at the API edge.
 */

const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export class InvalidAmountError extends Error {
  readonly code = 'INVALID_AMOUNT';
}

/**
 * Parses a decimal string ("1.25") into smallest units. Unlike a float parse it never
 * rounds: more fractional digits than the asset supports is an error, because silently
 * dropping digits is how balances drift.
 */
export function toUnits(value: string, decimals: number): bigint {
  if (!DECIMAL_RE.test(value)) {
    throw new InvalidAmountError(`not a non-negative decimal: "${value}"`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new InvalidAmountError(`"${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Formats smallest units as a decimal string without trailing zeros ("1.5", "0.000001"). */
export function fromUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
