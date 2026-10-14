import { randomUUID } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.js';
import { InMemoryCommandLog, type CommandLog } from '../matching/command-log.js';
import { MatchingEngine } from '../matching/engine.js';
import { OrderRejected } from '../matching/errors.js';
import type { BookSnapshot, Fill, OrderType, Side } from '../matching/types.js';
import { feeFor, lockAsset, maxFeeBps, notional, type Market } from './market.js';

export type OrderStatus = 'open' | 'filled' | 'cancelled';

export interface OrderView {
  id: string;
  userId: string;
  market: string;
  side: Side;
  type: OrderType;
  price?: bigint;
  qty: bigint;
  filled: bigint;
  status: OrderStatus;
}

export interface TradeView {
  id: string;
  market: string;
  seq: number;
  price: bigint;
  qty: bigint;
  takerSide: Side;
  makerOrderId: string;
  takerOrderId: string;
}

export type ExchangeEvent =
  | { type: 'trade'; trade: TradeView }
  /** Absolute size at a price level after a command; qty 0 means the level is gone. */
  | { type: 'book'; market: string; side: Side; price: bigint; qty: bigint };

export interface PlaceOrderInput {
  userId: string;
  market: string;
  side: Side;
  type: OrderType;
  /** Engine units (quote per lot). Required for limit orders, absent for market orders. */
  price?: bigint;
  /** Engine units (base smallest units). */
  qty: bigint;
}

export class ExchangeError extends Error {
  constructor(
    readonly code: 'UNKNOWN_MARKET' | 'NO_LIQUIDITY' | 'ORDER_NOT_FOUND' | 'ORDER_NOT_OPEN' | 'MARKET_HALTED',
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}

interface OrderState extends OrderView {
  /** Funds still reserved for this order in the ledger (quote for buys, base for sells). */
  reserved: bigint;
}

interface MarketRuntime {
  config: Market;
  engine: MatchingEngine;
  log: CommandLog;
  seq: number;
  /** Tail of the per-market command queue. */
  tail: Promise<unknown>;
  halted?: string;
}

export interface ExchangeServiceOptions {
  ledger: Ledger;
  markets: Market[];
  /** Command log per market. Defaults to in-memory; production would use a durable log. */
  commandLog?: (market: string) => CommandLog;
  idGen?: () => string;
}

/**
 * Glue between the matching engine and the ledger. The rules it enforces:
 *
 *  1. Lock before book. An order's worst-case cost is moved to `locked` before the engine
 *     sees it. If the lock fails the engine is never touched, so the book can only ever
 *     hold fully funded orders and every fill is guaranteed to settle.
 *  2. One fill, one journal entry, keyed by a trade id derived from the command sequence.
 *     Re-running settlement after a crash is therefore harmless.
 *  3. Whatever an order did not spend (cancel, market leftover, self-trade stop, price
 *     improvement, fee difference) goes back to `available` exactly once.
 *
 * Commands for one market run strictly one after another through a promise queue: the
 * engine is synchronous but ledger calls are async, and two orders must never interleave
 * between "compute lock" and "enter the book".
 */
export class ExchangeService {
  private readonly ledger: Ledger;
  private readonly markets = new Map<string, MarketRuntime>();
  private readonly orders = new Map<string, OrderState>();
  private readonly listeners = new Set<(event: ExchangeEvent) => void>();
  private readonly idGen: () => string;

  constructor(options: ExchangeServiceOptions) {
    this.ledger = options.ledger;
    this.idGen = options.idGen ?? randomUUID;
    for (const config of options.markets) {
      for (const asset of [config.base, config.quote]) {
        if (!this.ledger.hasAsset(asset)) throw new Error(`market ${config.market}: unknown asset ${asset}`);
      }
      this.markets.set(config.market, {
        config,
        engine: new MatchingEngine(config),
        log: options.commandLog?.(config.market) ?? new InMemoryCommandLog(),
        seq: 0,
        tail: Promise.resolve(),
      });
    }
  }

  market(symbol: string): Market {
    return this.runtime(symbol).config;
  }

  listMarkets(): Market[] {
    return [...this.markets.values()].map((m) => m.config);
  }

  book(symbol: string, depth = 50): BookSnapshot {
    return this.runtime(symbol).engine.book(depth);
  }

  commandLog(symbol: string): CommandLog {
    return this.runtime(symbol).log;
  }

  getOrder(orderId: string): OrderView | undefined {
    const order = this.orders.get(orderId);
    return order && view(order);
  }

  subscribe(listener: (event: ExchangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderView; trades: TradeView[] }> {
    const rt = this.runtime(input.market);
    return this.serialize(rt, () => this.place(rt, input));
  }

  async cancelOrder(userId: string, orderId: string): Promise<OrderView> {
    const order = this.orders.get(orderId);
    // Someone else's order looks exactly like a missing one: no id probing.
    if (!order || order.userId !== userId) {
      throw new ExchangeError('ORDER_NOT_FOUND', `order ${orderId} not found`);
    }
    const rt = this.runtime(order.market);
    return this.serialize(rt, () => this.cancel(rt, order));
  }

  // ---------------------------------------------------------------------------------------

  private async place(rt: MarketRuntime, input: PlaceOrderInput): Promise<{ order: OrderView; trades: TradeView[] }> {
    this.assertLive(rt);
    const { config, engine } = rt;
    const orderId = this.idGen();

    const reserve = this.requiredLock(rt, input);
    const asset = lockAsset(config, input.side);
    // Rule 1. Throws InsufficientFundsError before anything else happens.
    await this.ledger.lock({
      userId: input.userId,
      asset,
      amount: reserve,
      idempotencyKey: `order:${orderId}:lock`,
      ref: orderId,
    });

    const order: OrderState = {
      id: orderId,
      userId: input.userId,
      market: config.market,
      side: input.side,
      type: input.type,
      ...(input.price !== undefined && { price: input.price }),
      qty: input.qty,
      filled: 0n,
      status: 'open',
      reserved: reserve,
    };

    const before = engine.book(Number.MAX_SAFE_INTEGER);
    const cmd = {
      kind: 'place' as const,
      seq: rt.seq + 1,
      orderId,
      userId: input.userId,
      side: input.side,
      type: input.type,
      ...(input.price !== undefined && { price: input.price }),
      qty: input.qty,
    };
    // Write-ahead: the command is durable before it changes the book. The sequence number
    // is consumed even if the engine rejects the command; replay skips it the same way.
    rt.log.append(cmd);
    rt.seq = cmd.seq;

    let result;
    try {
      result = engine.place(cmd);
    } catch (err) {
      if (err instanceof OrderRejected) {
        await this.ledger.unlock({ userId: input.userId, asset, amount: reserve, idempotencyKey: `order:${orderId}:release` });
      }
      throw err;
    }
    this.orders.set(orderId, order);

    try {
      const trades = await this.settleFills(rt, result.fills);
      if (!result.resting) {
        order.status = order.filled === order.qty ? 'filled' : 'cancelled';
        await this.release(order);
      }
      this.emitBookDelta(rt, before);
      return { order: view(order), trades };
    } catch (err) {
      // The book has moved but the ledger did not follow. Stop taking orders on this
      // market; recovery replays the command log and re-runs the (idempotent) settlement.
      rt.halted = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async cancel(rt: MarketRuntime, order: OrderState): Promise<OrderView> {
    this.assertLive(rt);
    if (order.status !== 'open') {
      throw new ExchangeError('ORDER_NOT_OPEN', `order ${order.id} is ${order.status}`);
    }
    const before = rt.engine.book(Number.MAX_SAFE_INTEGER);
    const cmd = { kind: 'cancel' as const, seq: rt.seq + 1, orderId: order.id };
    rt.log.append(cmd);
    rt.seq = cmd.seq;
    const cancelled = rt.engine.cancel(cmd.seq, order.id);
    if (!cancelled) throw new ExchangeError('ORDER_NOT_OPEN', `order ${order.id} is not resting`);

    order.status = 'cancelled';
    await this.release(order);
    this.emitBookDelta(rt, before);
    return view(order);
  }

  private async settleFills(rt: MarketRuntime, fills: Fill[]): Promise<TradeView[]> {
    const { config } = rt;
    const trades: TradeView[] = [];

    for (const [i, fill] of fills.entries()) {
      const maker = this.mustOrder(fill.makerOrderId);
      const taker = this.mustOrder(fill.takerOrderId);
      const [buy, sell] = fill.takerSide === 'buy' ? [taker, maker] : [maker, taker];

      const quoteQty = notional(config, fill.price, fill.qty);
      const takerBps = config.takerFeeBps;
      const makerBps = config.makerFeeBps;
      const buyerFee = feeFor(quoteQty, fill.takerSide === 'buy' ? takerBps : makerBps);
      const sellerFee = feeFor(quoteQty, fill.takerSide === 'sell' ? takerBps : makerBps);

      // Deterministic from the command log, so a replay produces the same keys (rule 2).
      const tradeId = `${config.market}:${fill.seq}:${i}`;
      await this.ledger.settleTrade({
        idempotencyKey: `trade:${tradeId}`,
        ref: tradeId,
        base: config.base,
        quote: config.quote,
        buyerId: buy.userId,
        sellerId: sell.userId,
        baseQty: fill.qty,
        quoteQty,
        buyerFee,
        sellerFee,
      });

      buy.reserved -= quoteQty + buyerFee;
      sell.reserved -= fill.qty;
      maker.filled += fill.qty;
      taker.filled += fill.qty;

      if (maker.filled === maker.qty) {
        maker.status = 'filled';
        await this.release(maker);
      }

      const trade: TradeView = {
        id: tradeId,
        market: config.market,
        seq: fill.seq,
        price: fill.price,
        qty: fill.qty,
        takerSide: fill.takerSide,
        makerOrderId: fill.makerOrderId,
        takerOrderId: fill.takerOrderId,
      };
      trades.push(trade);
      this.emit({ type: 'trade', trade });
    }
    return trades;
  }

  /** Rule 3: return what a finished order did not spend. */
  private async release(order: OrderState): Promise<void> {
    if (order.reserved < 0n) throw new Error(`order ${order.id} overspent its reservation by ${-order.reserved}`);
    if (order.reserved === 0n) return;
    const amount = order.reserved;
    await this.ledger.unlock({
      userId: order.userId,
      asset: lockAsset(this.runtime(order.market).config, order.side),
      amount,
      idempotencyKey: `order:${order.id}:release`,
      ref: order.id,
    });
    order.reserved = 0n;
  }

  /**
   * Worst-case cost of an order. Limit buy: notional at the limit price plus the higher
   * of the two fee rates (we do not know yet whether it will be maker or taker). Market
   * buy: the cost of sweeping the current asks for the full quantity plus the taker fee;
   * this is exact because the market is serialized and nothing can change the book
   * between this calculation and the match. Sells reserve the base quantity.
   */
  private requiredLock(rt: MarketRuntime, input: PlaceOrderInput): bigint {
    const { config, engine } = rt;
    // Shape checks the lock math depends on; the engine re-validates everything.
    if (input.qty <= 0n || input.qty % config.lotSize !== 0n) {
      throw new OrderRejected('INVALID_LOT', `qty must be a positive multiple of ${config.lotSize}`);
    }
    if (input.type === 'limit') {
      if (input.price === undefined || input.price <= 0n || input.price % config.tickSize !== 0n) {
        throw new OrderRejected('INVALID_TICK', `price must be a positive multiple of ${config.tickSize}`);
      }
    } else if (input.price !== undefined) {
      throw new OrderRejected('UNEXPECTED_PRICE', 'market orders must not carry a price');
    }

    if (input.side === 'sell') {
      if (input.type === 'market' && engine.book(1).bids.length === 0) {
        throw new ExchangeError('NO_LIQUIDITY', 'no bids to sell into');
      }
      return input.qty;
    }

    if (input.type === 'limit') {
      const cost = notional(config, input.price!, input.qty);
      return cost + feeFor(cost, maxFeeBps(config));
    }

    let remaining = input.qty;
    let cost = 0n;
    for (const [price, size] of engine.book(Number.MAX_SAFE_INTEGER).asks) {
      if (remaining === 0n) break;
      const take = size < remaining ? size : remaining;
      cost += notional(config, price, take);
      remaining -= take;
    }
    if (cost === 0n) throw new ExchangeError('NO_LIQUIDITY', 'no asks to buy from');
    return cost + feeFor(cost, config.takerFeeBps);
  }

  private emitBookDelta(rt: MarketRuntime, before: BookSnapshot): void {
    const after = rt.engine.book(Number.MAX_SAFE_INTEGER);
    for (const side of ['buy', 'sell'] as const) {
      const key = side === 'buy' ? 'bids' : 'asks';
      const old = new Map(before[key].map(([p, q]) => [p, q]));
      const now = new Map(after[key].map(([p, q]) => [p, q]));
      for (const [price, qty] of now) {
        if (old.get(price) !== qty) this.emit({ type: 'book', market: rt.config.market, side, price, qty });
      }
      for (const price of old.keys()) {
        if (!now.has(price)) this.emit({ type: 'book', market: rt.config.market, side, price, qty: 0n });
      }
    }
  }

  private emit(event: ExchangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break order processing.
      }
    }
  }

  private serialize<T>(rt: MarketRuntime, task: () => Promise<T>): Promise<T> {
    const run = rt.tail.then(task);
    rt.tail = run.catch(() => undefined);
    return run;
  }

  private runtime(symbol: string): MarketRuntime {
    const rt = this.markets.get(symbol);
    if (!rt) throw new ExchangeError('UNKNOWN_MARKET', `unknown market ${symbol}`);
    return rt;
  }

  private assertLive(rt: MarketRuntime): void {
    if (rt.halted) throw new ExchangeError('MARKET_HALTED', `market ${rt.config.market} is halted: ${rt.halted}`);
  }

  private mustOrder(id: string): OrderState {
    const order = this.orders.get(id);
    if (!order) throw new Error(`engine reported unknown order ${id}`);
    return order;
  }
}

function view(order: OrderState): OrderView {
  const { reserved: _reserved, ...rest } = order;
  return { ...rest };
}
