import { OrderRejected } from './errors.js';
import type {
  BookLevel,
  BookSnapshot,
  Fill,
  MarketConfig,
  Order,
  PlaceCommand,
  PlaceResult,
  Side,
} from './types.js';

export { OrderRejected } from './errors.js';
export type { RejectCode } from './errors.js';

interface PriceLevel {
  price: bigint;
  /** FIFO queue: index 0 has time priority. */
  orders: Order[];
}

/*
 * Book layout: each side is an array of price levels sorted best-first
 * (bids descending, asks ascending), each level a FIFO array of orders, plus a
 * Map from order id to order for O(1) lookup.
 *
 * Complexity: best price is O(1), matching is O(fills), inserting or removing a
 * level is O(levels) because of array splice, cancelling inside a level is
 * O(orders at that level). That is fine for an MVP with tens or hundreds of
 * active levels. At scale the levels would move to a balanced tree or a
 * heap + hash map, and each level to an intrusive linked list for O(1) cancel.
 */
export class MatchingEngine {
  readonly market: string;
  readonly tickSize: bigint;
  readonly lotSize: bigint;

  private readonly bids: PriceLevel[] = [];
  private readonly asks: PriceLevel[] = [];
  private readonly resting = new Map<string, Order>();
  // Ids stay reserved after an order is filled or cancelled, so a replayed
  // or retried command can never be confused with a new order.
  private readonly usedIds = new Set<string>();
  private lastSeqValue = 0;

  constructor(config: MarketConfig) {
    if (config.tickSize <= 0n) throw new RangeError('tickSize must be positive');
    if (config.lotSize <= 0n) throw new RangeError('lotSize must be positive');
    this.market = config.market;
    this.tickSize = config.tickSize;
    this.lotSize = config.lotSize;
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  place(cmd: PlaceCommand): PlaceResult {
    this.validatePlace(cmd);
    this.lastSeqValue = cmd.seq;
    this.usedIds.add(cmd.orderId);

    const taker: Order = {
      id: cmd.orderId,
      userId: cmd.userId,
      side: cmd.side,
      type: cmd.type,
      ...(cmd.type === 'limit' && cmd.price !== undefined ? { price: cmd.price } : {}),
      qty: cmd.qty,
      remaining: cmd.qty,
      seq: cmd.seq,
    };

    const fills: Fill[] = [];
    const opposite = taker.side === 'buy' ? this.asks : this.bids;
    let selfTradeStop = false;

    while (taker.remaining > 0n) {
      const level = opposite[0];
      if (level === undefined || !this.crosses(taker, level.price)) break;

      const maker = level.orders[0];
      if (maker === undefined) {
        opposite.shift();
        continue;
      }
      if (maker.userId === taker.userId) {
        selfTradeStop = true;
        break;
      }

      const qty = maker.remaining < taker.remaining ? maker.remaining : taker.remaining;
      maker.remaining -= qty;
      taker.remaining -= qty;
      fills.push({
        seq: cmd.seq,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        makerUserId: maker.userId,
        takerUserId: taker.userId,
        price: level.price,
        qty,
        takerSide: taker.side,
      });

      if (maker.remaining === 0n) {
        level.orders.shift();
        this.resting.delete(maker.id);
        if (level.orders.length === 0) opposite.shift();
      }
    }

    if (taker.remaining > 0n && taker.type === 'limit' && !selfTradeStop) {
      this.rest(taker);
      return { fills, resting: { ...taker }, cancelledQty: 0n };
    }
    return { fills, cancelledQty: taker.remaining };
  }

  /** Returns the cancelled order as it was at cancel time, or null if not resting. */
  cancel(seq: number, orderId: string): Order | null {
    this.checkSeq(seq);
    this.lastSeqValue = seq;

    const order = this.resting.get(orderId);
    if (order === undefined || order.price === undefined) return null;

    const side = order.side === 'buy' ? this.bids : this.asks;
    const levelIndex = this.findLevel(side, order.side, order.price);
    const level = side[levelIndex];
    if (level === undefined || level.price !== order.price) return null;

    const at = level.orders.indexOf(order);
    if (at >= 0) level.orders.splice(at, 1);
    if (level.orders.length === 0) side.splice(levelIndex, 1);
    this.resting.delete(orderId);
    return { ...order };
  }

  getOrder(id: string): Order | undefined {
    const order = this.resting.get(id);
    return order === undefined ? undefined : { ...order };
  }

  /** Aggregated depth: bids best (highest) first, asks best (lowest) first. */
  book(depth = 50): BookSnapshot {
    return { bids: aggregate(this.bids, depth), asks: aggregate(this.asks, depth) };
  }

  /** All resting orders in priority order: bids then asks, best price first, FIFO within a level. */
  restingOrders(): Order[] {
    const out: Order[] = [];
    for (const level of [...this.bids, ...this.asks]) {
      for (const order of level.orders) out.push({ ...order });
    }
    return out;
  }

  private validatePlace(cmd: PlaceCommand): void {
    this.checkSeq(cmd.seq);
    if (this.usedIds.has(cmd.orderId)) {
      throw new OrderRejected('DUPLICATE_ORDER_ID', `order id ${cmd.orderId} already used`);
    }
    if (cmd.qty <= 0n) {
      throw new OrderRejected('INVALID_QTY', `qty must be positive, got ${cmd.qty}`);
    }
    if (cmd.qty % this.lotSize !== 0n) {
      throw new OrderRejected('INVALID_LOT', `qty ${cmd.qty} is not a multiple of lot ${this.lotSize}`);
    }
    if (cmd.type === 'market') {
      if (cmd.price !== undefined) {
        throw new OrderRejected('UNEXPECTED_PRICE', 'market orders must not carry a price');
      }
      return;
    }
    if (cmd.price === undefined) {
      throw new OrderRejected('MISSING_PRICE', 'limit orders require a price');
    }
    if (cmd.price <= 0n) {
      throw new OrderRejected('INVALID_PRICE', `price must be positive, got ${cmd.price}`);
    }
    if (cmd.price % this.tickSize !== 0n) {
      throw new OrderRejected('INVALID_TICK', `price ${cmd.price} is not a multiple of tick ${this.tickSize}`);
    }
  }

  private checkSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= this.lastSeqValue) {
      throw new OrderRejected('INVALID_SEQ', `seq ${seq} must be greater than ${this.lastSeqValue}`);
    }
  }

  private crosses(taker: Order, makerPrice: bigint): boolean {
    if (taker.type === 'market' || taker.price === undefined) return true;
    return taker.side === 'buy' ? taker.price >= makerPrice : taker.price <= makerPrice;
  }

  private rest(order: Order): void {
    const price = order.price as bigint;
    const side = order.side === 'buy' ? this.bids : this.asks;
    const index = this.findLevel(side, order.side, price);
    const existing = side[index];
    if (existing !== undefined && existing.price === price) {
      existing.orders.push(order);
    } else {
      side.splice(index, 0, { price, orders: [order] });
    }
    this.resting.set(order.id, order);
  }

  /** Binary search: index of the level with this price, or where it should be inserted. */
  private findLevel(levels: PriceLevel[], side: Side, price: bigint): number {
    let lo = 0;
    let hi = levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midPrice = (levels[mid] as PriceLevel).price;
      const better = side === 'buy' ? midPrice > price : midPrice < price;
      if (better) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function aggregate(levels: PriceLevel[], depth: number): BookLevel[] {
  const out: BookLevel[] = [];
  for (const level of levels.slice(0, Math.max(0, depth))) {
    let total = 0n;
    for (const order of level.orders) total += order.remaining;
    out.push([level.price, total]);
  }
  return out;
}
