import { beforeEach, describe, expect, it } from 'vitest';
import { MatchingEngine, OrderRejected } from '../../src/matching/engine.js';
import type { PlaceCommand, Side } from '../../src/matching/types.js';

const config = { market: 'BTC-USDT', tickSize: 5n, lotSize: 10n };

let engine: MatchingEngine;
let seq = 0;

function limit(orderId: string, userId: string, side: Side, price: bigint, qty: bigint) {
  return engine.place({ seq: ++seq, orderId, userId, side, type: 'limit', price, qty });
}

function market(orderId: string, userId: string, side: Side, qty: bigint) {
  return engine.place({ seq: ++seq, orderId, userId, side, type: 'market', qty });
}

function rejectCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(OrderRejected);
    return (err as OrderRejected).code;
  }
  return undefined;
}

function expectReject(cmd: Partial<PlaceCommand>, code: string) {
  const full: PlaceCommand = {
    seq: ++seq,
    orderId: 'x',
    userId: 'u',
    side: 'buy',
    type: 'limit',
    price: 100n,
    qty: 10n,
    ...cmd,
  };
  expect(rejectCode(() => engine.place(full))).toBe(code);
}

beforeEach(() => {
  engine = new MatchingEngine(config);
  seq = 0;
});

describe('MatchingEngine', () => {
  it('rests a non-crossing limit order', () => {
    const res = limit('b1', 'alice', 'buy', 100n, 30n);
    expect(res.fills).toEqual([]);
    expect(res.cancelledQty).toBe(0n);
    expect(res.resting).toMatchObject({ id: 'b1', price: 100n, qty: 30n, remaining: 30n, seq: 1 });
    expect(engine.getOrder('b1')?.remaining).toBe(30n);
    expect(engine.book()).toEqual({ bids: [[100n, 30n]], asks: [] });
  });

  it('crosses at the maker price, not the taker price', () => {
    limit('s1', 'alice', 'sell', 100n, 20n);
    const res = limit('b1', 'bob', 'buy', 120n, 20n);
    expect(res.fills).toEqual([
      {
        seq: 2,
        makerOrderId: 's1',
        takerOrderId: 'b1',
        makerUserId: 'alice',
        takerUserId: 'bob',
        price: 100n,
        qty: 20n,
        takerSide: 'buy',
      },
    ]);
    expect(res.resting).toBeUndefined();
    expect(engine.book()).toEqual({ bids: [], asks: [] });
  });

  it('partially fills the maker and leaves the rest on the book', () => {
    limit('s1', 'alice', 'sell', 100n, 50n);
    const res = limit('b1', 'bob', 'buy', 100n, 20n);
    expect(res.fills.map((f) => f.qty)).toEqual([20n]);
    expect(engine.getOrder('s1')?.remaining).toBe(30n);
    expect(engine.getOrder('b1')).toBeUndefined();
    expect(engine.book().asks).toEqual([[100n, 30n]]);
  });

  it('partially fills the taker and rests the limit remainder', () => {
    limit('s1', 'alice', 'sell', 100n, 20n);
    const res = limit('b1', 'bob', 'buy', 105n, 50n);
    expect(res.fills.map((f) => f.qty)).toEqual([20n]);
    expect(res.resting).toMatchObject({ id: 'b1', price: 105n, remaining: 30n, qty: 50n });
    expect(engine.book()).toEqual({ bids: [[105n, 30n]], asks: [] });
  });

  it('matches FIFO within a price level', () => {
    limit('s1', 'alice', 'sell', 100n, 20n);
    limit('s2', 'carol', 'sell', 100n, 20n);
    limit('s3', 'dave', 'sell', 100n, 20n);
    const res = limit('b1', 'bob', 'buy', 100n, 30n);
    expect(res.fills.map((f) => [f.makerOrderId, f.qty])).toEqual([
      ['s1', 20n],
      ['s2', 10n],
    ]);
    expect(engine.restingOrders().map((o) => [o.id, o.remaining])).toEqual([
      ['s2', 10n],
      ['s3', 20n],
    ]);
  });

  it('matches the best price first across levels', () => {
    limit('b1', 'alice', 'buy', 90n, 10n);
    limit('b2', 'carol', 'buy', 95n, 10n);
    limit('b3', 'dave', 'buy', 85n, 10n);
    const res = limit('s1', 'bob', 'sell', 85n, 30n);
    expect(res.fills.map((f) => [f.makerOrderId, f.price])).toEqual([
      ['b2', 95n],
      ['b1', 90n],
      ['b3', 85n],
    ]);
  });

  it('sweeps several levels with a market order and cancels the leftover', () => {
    limit('s1', 'alice', 'sell', 100n, 10n);
    limit('s2', 'alice', 'sell', 105n, 20n);
    limit('s3', 'carol', 'sell', 110n, 30n);
    const res = market('m1', 'bob', 'buy', 100n);
    expect(res.fills.map((f) => [f.makerOrderId, f.price, f.qty])).toEqual([
      ['s1', 100n, 10n],
      ['s2', 105n, 20n],
      ['s3', 110n, 30n],
    ]);
    expect(res.cancelledQty).toBe(40n);
    expect(res.resting).toBeUndefined();
    expect(engine.book()).toEqual({ bids: [], asks: [] });
  });

  it('cancels the whole market order when the book is empty', () => {
    const res = market('m1', 'bob', 'sell', 30n);
    expect(res).toEqual({ fills: [], cancelledQty: 30n });
  });

  it('does not cross a limit order past its price', () => {
    limit('s1', 'alice', 'sell', 105n, 10n);
    const res = limit('b1', 'bob', 'buy', 100n, 10n);
    expect(res.fills).toEqual([]);
    expect(engine.book()).toEqual({ bids: [[100n, 10n]], asks: [[105n, 10n]] });
  });

  it('cancels a resting order and returns it', () => {
    limit('b1', 'alice', 'buy', 100n, 30n);
    limit('b2', 'carol', 'buy', 100n, 20n);
    const cancelled = engine.cancel(++seq, 'b1');
    expect(cancelled).toMatchObject({ id: 'b1', remaining: 30n });
    expect(engine.getOrder('b1')).toBeUndefined();
    expect(engine.book().bids).toEqual([[100n, 20n]]);
    engine.cancel(++seq, 'b2');
    expect(engine.book()).toEqual({ bids: [], asks: [] });
  });

  it('returns null when cancelling an unknown or already filled order', () => {
    limit('s1', 'alice', 'sell', 100n, 10n);
    limit('b1', 'bob', 'buy', 100n, 10n);
    expect(engine.cancel(++seq, 's1')).toBeNull();
    expect(engine.cancel(++seq, 'nope')).toBeNull();
  });

  it('cancelled orders no longer match', () => {
    limit('s1', 'alice', 'sell', 100n, 10n);
    engine.cancel(++seq, 's1');
    const res = limit('b1', 'bob', 'buy', 100n, 10n);
    expect(res.fills).toEqual([]);
  });

  describe('validation', () => {
    it('rejects a price off the tick grid', () => {
      expectReject({ price: 102n }, 'INVALID_TICK');
    });

    it('rejects a non-positive or missing limit price', () => {
      expectReject({ price: 0n }, 'INVALID_PRICE');
      expectReject({ price: -5n }, 'INVALID_PRICE');
      const noPrice: PlaceCommand = { seq: ++seq, orderId: 'x', userId: 'u', side: 'buy', type: 'limit', qty: 10n };
      expect(rejectCode(() => engine.place(noPrice))).toBe('MISSING_PRICE');
    });

    it('rejects a market order that carries a price', () => {
      expectReject({ type: 'market', price: 100n }, 'UNEXPECTED_PRICE');
    });

    it('rejects qty off the lot grid or not positive', () => {
      expectReject({ qty: 15n }, 'INVALID_LOT');
      expectReject({ qty: 0n }, 'INVALID_QTY');
      expectReject({ qty: -10n }, 'INVALID_QTY');
    });

    it('rejects a duplicate order id, including ids of finished orders', () => {
      limit('s1', 'alice', 'sell', 100n, 10n);
      limit('b1', 'bob', 'buy', 100n, 10n);
      expectReject({ orderId: 's1' }, 'DUPLICATE_ORDER_ID');
      expectReject({ orderId: 'b1' }, 'DUPLICATE_ORDER_ID');
    });

    it('rejects a seq that does not strictly increase', () => {
      limit('b1', 'alice', 'buy', 100n, 10n);
      expectReject({ seq: 1, orderId: 'b2' }, 'INVALID_SEQ');
      expectReject({ seq: 0, orderId: 'b2' }, 'INVALID_SEQ');
      expect(rejectCode(() => engine.cancel(1, 'b1'))).toBe('INVALID_SEQ');
    });

    it('leaves state untouched after a rejection', () => {
      limit('s1', 'alice', 'sell', 100n, 10n);
      const before = engine.book();
      const lastSeq = engine.lastSeq;
      expectReject({ side: 'buy', price: 100n, qty: 15n }, 'INVALID_LOT');
      expect(engine.book()).toEqual(before);
      expect(engine.lastSeq).toBe(lastSeq);
    });

    it('rejects a non-positive tick or lot size in the config', () => {
      expect(() => new MatchingEngine({ ...config, tickSize: 0n })).toThrow(RangeError);
      expect(() => new MatchingEngine({ ...config, lotSize: -1n })).toThrow(RangeError);
    });
  });

  describe('self-trade prevention', () => {
    it('cancels the taker remainder when the next maker is the same user', () => {
      limit('s1', 'carol', 'sell', 100n, 10n);
      limit('s2', 'bob', 'sell', 105n, 20n);
      limit('s3', 'carol', 'sell', 110n, 20n);
      const res = limit('b1', 'bob', 'buy', 110n, 50n);
      expect(res.fills.map((f) => f.makerOrderId)).toEqual(['s1']);
      expect(res.cancelledQty).toBe(40n);
      expect(res.resting).toBeUndefined();
      expect(engine.getOrder('s2')?.remaining).toBe(20n);
      expect(engine.book()).toEqual({
        bids: [],
        asks: [
          [105n, 20n],
          [110n, 20n],
        ],
      });
    });

    it('applies to market orders too', () => {
      limit('s1', 'bob', 'sell', 100n, 10n);
      const res = market('m1', 'bob', 'buy', 30n);
      expect(res).toEqual({ fills: [], cancelledQty: 30n });
      expect(engine.getOrder('s1')?.remaining).toBe(10n);
    });

    it('lets a same-user limit order rest when it does not cross', () => {
      limit('s1', 'bob', 'sell', 105n, 10n);
      const res = limit('b1', 'bob', 'buy', 100n, 10n);
      expect(res.cancelledQty).toBe(0n);
      expect(res.resting?.id).toBe('b1');
    });
  });

  describe('book', () => {
    it('aggregates per level, bids descending and asks ascending', () => {
      limit('b1', 'a', 'buy', 90n, 10n);
      limit('b2', 'b', 'buy', 95n, 20n);
      limit('b3', 'c', 'buy', 90n, 30n);
      limit('s1', 'a', 'sell', 110n, 10n);
      limit('s2', 'b', 'sell', 105n, 20n);
      limit('s3', 'c', 'sell', 110n, 40n);
      expect(engine.book()).toEqual({
        bids: [
          [95n, 20n],
          [90n, 40n],
        ],
        asks: [
          [105n, 20n],
          [110n, 50n],
        ],
      });
    });

    it('respects depth', () => {
      for (let i = 1; i <= 5; i++) limit(`b${i}`, 'a', 'buy', BigInt(i) * 5n, 10n);
      expect(engine.book(2).bids).toEqual([
        [25n, 10n],
        [20n, 10n],
      ]);
      expect(engine.book(0).bids).toEqual([]);
    });

    it('returns copies, so callers cannot mutate the book', () => {
      limit('b1', 'a', 'buy', 90n, 10n);
      const order = engine.getOrder('b1');
      if (order) order.remaining = 0n;
      expect(engine.getOrder('b1')?.remaining).toBe(10n);
    });
  });
});
