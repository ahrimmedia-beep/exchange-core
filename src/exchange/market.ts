import { InvalidAmountError, fromUnits, toUnits } from '../ledger/money.js';
import type { MarketConfig, Side } from '../matching/types.js';

/**
 * A tradable pair. Engine units, as in src/matching:
 *   - quantity: base smallest units, a multiple of lotSize
 *   - price:    quote smallest units per lot, a multiple of tickSize
 * With price per lot, notional = price * qty / lotSize is always an exact integer,
 * because qty is a whole number of lots. No rounding anywhere on the money path.
 */
export interface Market extends MarketConfig {
  base: string;
  quote: string;
  baseDecimals: number;
  quoteDecimals: number;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
}

const BPS = 10_000n;

export function notional(market: Market, price: bigint, qty: bigint): bigint {
  return (price * qty) / market.lotSize;
}

/**
 * Fees round down. Rounding up would let the sum of per-fill fees exceed the fee that was
 * locked for the whole order (ceil(a) + ceil(b) can be > ceil(a + b)), and a fill would
 * then fail on settlement. Rounding down costs the exchange at most one unit per fill.
 */
export function feeFor(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / BPS;
}

export function maxFeeBps(market: Market): bigint {
  return market.makerFeeBps > market.takerFeeBps ? market.makerFeeBps : market.takerFeeBps;
}

/** The asset an order reserves: quote for buys, base for sells. */
export function lockAsset(market: Market, side: Side): string {
  return side === 'buy' ? market.quote : market.base;
}

// ---- conversion between API decimals and engine units --------------------------------

const baseUnit = (m: Market) => 10n ** BigInt(m.baseDecimals);

/** "2000.5" (quote per one whole base unit) -> engine price per lot. */
export function priceToEngine(market: Market, price: string): bigint {
  const perWholeBase = toUnits(price, market.quoteDecimals);
  const scaled = perWholeBase * market.lotSize;
  if (scaled % baseUnit(market) !== 0n) {
    throw new InvalidAmountError(`price ${price} is finer than the market allows`);
  }
  return scaled / baseUnit(market);
}

export function priceFromEngine(market: Market, price: bigint): string {
  return fromUnits((price * baseUnit(market)) / market.lotSize, market.quoteDecimals);
}

export function qtyToEngine(market: Market, qty: string): bigint {
  return toUnits(qty, market.baseDecimals);
}

export function qtyFromEngine(market: Market, qty: bigint): string {
  return fromUnits(qty, market.baseDecimals);
}
