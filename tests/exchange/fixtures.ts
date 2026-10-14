import { ExchangeService } from '../../src/exchange/exchange-service.js';
import { priceToEngine, qtyToEngine, type Market } from '../../src/exchange/market.js';
import { InMemoryLedgerStore, Ledger } from '../../src/ledger/index.js';

export const ASSETS = { ETH: { decimals: 18 }, USDT: { decimals: 6 } };

/** 0.001 ETH lots, 0.01 USDT price ticks, 0.10% maker / 0.20% taker fees. */
export const ETH_USDT: Market = {
  market: 'ETH-USDT',
  base: 'ETH',
  quote: 'USDT',
  baseDecimals: 18,
  quoteDecimals: 6,
  lotSize: 10n ** 15n,
  tickSize: 10n,
  makerFeeBps: 10n,
  takerFeeBps: 20n,
};

export const px = (p: string) => priceToEngine(ETH_USDT, p);
export const qty = (q: string) => qtyToEngine(ETH_USDT, q);
export const usdt = (v: string) => qtyToEngine({ ...ETH_USDT, baseDecimals: 6 }, v);

export function setup() {
  const store = new InMemoryLedgerStore();
  const ledger = new Ledger(store, ASSETS);
  let n = 0;
  const exchange = new ExchangeService({ ledger, markets: [ETH_USDT], idGen: () => `o${++n}` });
  const fund = (userId: string, asset: 'ETH' | 'USDT', amount: bigint) =>
    ledger.deposit({ userId, asset, amount, idempotencyKey: `fund:${userId}:${asset}:${amount}` });
  return { store, ledger, exchange, fund };
}
