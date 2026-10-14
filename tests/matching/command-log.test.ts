import { describe, expect, it } from 'vitest';
import { InMemoryCommandLog, applyCommand, replay } from '../../src/matching/command-log.js';
import { MatchingEngine, OrderRejected } from '../../src/matching/engine.js';
import type { Command, Fill, MarketConfig } from '../../src/matching/types.js';

const config: MarketConfig = { market: 'ETH-USDT', tickSize: 5n, lotSize: 10n };

/** mulberry32: tiny seeded PRNG so the random scenario is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCommands(seed: number, count: number): Command[] {
  const rand = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const users = ['u1', 'u2', 'u3', 'u4'];
  const ids: string[] = [];
  const commands: Command[] = [];

  for (let seq = 1; seq <= count; seq++) {
    const roll = rand();
    const userId = users[int(0, users.length - 1)] as string;
    const side = rand() < 0.5 ? 'buy' : 'sell';
    const qty = config.lotSize * BigInt(int(1, 10));

    if (roll < 0.55) {
      const orderId = `o${seq}`;
      ids.push(orderId);
      const price = 1000n + config.tickSize * BigInt(int(-6, 6));
      commands.push({ kind: 'place', seq, orderId, userId, side, type: 'limit', price, qty });
    } else if (roll < 0.7) {
      const orderId = `o${seq}`;
      ids.push(orderId);
      commands.push({ kind: 'place', seq, orderId, userId, side, type: 'market', qty });
    } else if (roll < 0.95) {
      const orderId = ids.length > 0 && rand() < 0.9 ? (ids[int(0, ids.length - 1)] as string) : 'missing';
      commands.push({ kind: 'cancel', seq, orderId });
    } else {
      // Invalid on purpose: off-tick price or a reused id. Replay must reject these identically.
      const orderId = ids.length > 0 && rand() < 0.5 ? (ids[0] as string) : `bad${seq}`;
      commands.push({ kind: 'place', seq, orderId, userId, side, type: 'limit', price: 1001n, qty });
    }
  }
  return commands;
}

interface LiveRun {
  engine: MatchingEngine;
  log: InMemoryCommandLog;
  fills: Fill[];
  rejected: number;
  accounting: Map<string, { qty: bigint; filled: bigint; cancelled: bigint }>;
}

function runLive(commands: Command[]): LiveRun {
  const engine = new MatchingEngine(config);
  const log = new InMemoryCommandLog();
  const fills: Fill[] = [];
  const accounting = new Map<string, { qty: bigint; filled: bigint; cancelled: bigint }>();
  let rejected = 0;

  for (const cmd of commands) {
    log.append(cmd);
    try {
      const applied = applyCommand(engine, cmd);
      if (applied.kind === 'place') {
        accounting.set(cmd.orderId, { qty: (cmd as { qty: bigint }).qty, filled: 0n, cancelled: 0n });
        for (const fill of applied.result.fills) {
          fills.push(fill);
          (accounting.get(fill.makerOrderId) as { filled: bigint }).filled += fill.qty;
          (accounting.get(fill.takerOrderId) as { filled: bigint }).filled += fill.qty;
        }
        (accounting.get(cmd.orderId) as { cancelled: bigint }).cancelled += applied.result.cancelledQty;
      } else if (applied.cancelled) {
        (accounting.get(applied.cancelled.id) as { cancelled: bigint }).cancelled += applied.cancelled.remaining;
      }
    } catch (err) {
      if (!(err instanceof OrderRejected)) throw err;
      rejected++;
    }
  }
  return { engine, log, fills, rejected, accounting };
}

describe('InMemoryCommandLog', () => {
  it('keeps commands in order and hands out copies', () => {
    const log = new InMemoryCommandLog();
    log.append({ kind: 'cancel', seq: 1, orderId: 'a' });
    log.append({ kind: 'cancel', seq: 2, orderId: 'b' });
    const all = log.all();
    expect(all.map((c) => c.seq)).toEqual([1, 2]);
    (all[0] as { orderId: string }).orderId = 'mutated';
    expect(log.all()[0]).toEqual({ kind: 'cancel', seq: 1, orderId: 'a' });
  });
});

describe('applyCommand', () => {
  it('routes place and cancel commands', () => {
    const engine = new MatchingEngine(config);
    const placed = applyCommand(engine, {
      kind: 'place',
      seq: 1,
      orderId: 'b1',
      userId: 'u1',
      side: 'buy',
      type: 'limit',
      price: 1000n,
      qty: 20n,
    });
    expect(placed.kind).toBe('place');
    const cancelled = applyCommand(engine, { kind: 'cancel', seq: 2, orderId: 'b1' });
    expect(cancelled).toMatchObject({ kind: 'cancel', cancelled: { id: 'b1', remaining: 20n } });
  });
});

describe('replay', () => {
  it('rebuilds an identical engine from a random 500-command log', () => {
    const live = runLive(randomCommands(20261014, 500));
    expect(live.fills.length).toBeGreaterThan(50);
    expect(live.rejected).toBeGreaterThan(0);

    const replayed = replay(live.log, config);
    expect(replayed.fills).toEqual(live.fills);
    expect(replayed.engine.book(1000)).toEqual(live.engine.book(1000));
    expect(replayed.engine.restingOrders()).toEqual(live.engine.restingOrders());
    expect(replayed.engine.lastSeq).toBe(live.engine.lastSeq);
  });

  it('is deterministic across several seeds', () => {
    for (const seed of [1, 42, 9001]) {
      const live = runLive(randomCommands(seed, 500));
      const first = replay(live.log, config);
      const second = replay(live.log, config);
      expect(first.fills).toEqual(live.fills);
      expect(second.fills).toEqual(first.fills);
      expect(second.engine.restingOrders()).toEqual(live.engine.restingOrders());
    }
  });

  it('rethrows errors that are not order rejections', () => {
    const broken = { append: () => undefined, all: () => [null as unknown as Command] };
    expect(() => replay(broken, config)).toThrow(TypeError);
  });
});

describe('invariants on a random run', () => {
  const live = runLive(randomCommands(7, 500));

  it('conserves quantity: fills + cancelled + resting = original qty for every order', () => {
    expect(live.accounting.size).toBeGreaterThan(100);
    for (const [id, acc] of live.accounting) {
      const resting = live.engine.getOrder(id)?.remaining ?? 0n;
      expect(acc.filled + acc.cancelled + resting, `order ${id}`).toBe(acc.qty);
    }
  });

  it('never trades a user against itself and keeps every fill on the lot grid', () => {
    for (const fill of live.fills) {
      expect(fill.makerUserId).not.toBe(fill.takerUserId);
      expect(fill.qty > 0n).toBe(true);
      expect(fill.qty % config.lotSize).toBe(0n);
      expect(fill.price % config.tickSize).toBe(0n);
    }
  });

  it('never leaves a crossed book', () => {
    const { bids, asks } = live.engine.book();
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (bestBid && bestAsk) expect(bestBid[0] < bestAsk[0]).toBe(true);
  });
});
