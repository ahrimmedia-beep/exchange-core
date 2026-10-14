import { describe, expect, it } from 'vitest';
import type { ExchangeEvent } from '../../src/exchange/exchange-service.js';
import { feesAccount } from '../../src/ledger/accounts.js';
import { InsufficientFundsError, checkInvariants } from '../../src/ledger/index.js';
import { replay } from '../../src/matching/command-log.js';
import { OrderRejected } from '../../src/matching/errors.js';
import { ETH_USDT, px, qty, setup, usdt } from './fixtures.js';

describe('ExchangeService', () => {
  it('locks notional plus the higher fee before a limit buy enters the book', async () => {
    const { exchange, ledger, fund } = setup();
    await fund('bob', 'USDT', usdt('5000'));

    await exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1') });

    // 2000 notional + 0.20% (max of maker/taker) = 2004
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: usdt('2996'), locked: usdt('2004') });
    expect(exchange.book('ETH-USDT').bids).toEqual([[px('2000'), qty('1')]]);
  });

  it('rejects an underfunded order without touching the book or the ledger', async () => {
    const { exchange, store, fund } = setup();
    await fund('bob', 'USDT', usdt('100'));
    const entries = store.entryCount;

    await expect(
      exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1') }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(exchange.book('ETH-USDT')).toEqual({ bids: [], asks: [] });
    expect(store.entryCount).toBe(entries);
  });

  it('rejects bad tick or lot before reserving anything', async () => {
    const { exchange, store, fund } = setup();
    await fund('bob', 'USDT', usdt('5000'));
    const entries = store.entryCount;

    await expect(
      exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000') + 1n, qty: qty('1') }),
    ).rejects.toBeInstanceOf(OrderRejected);
    await expect(
      exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1') + 1n }),
    ).rejects.toBeInstanceOf(OrderRejected);
    expect(store.entryCount).toBe(entries);
  });

  it('settles a crossing trade with maker and taker fees in one entry', async () => {
    const { exchange, ledger, store, fund } = setup();
    await fund('sam', 'ETH', qty('1'));
    await fund('bob', 'USDT', usdt('5000'));

    await exchange.placeOrder({ userId: 'sam', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2000'), qty: qty('1') });
    const { order, trades } = await exchange.placeOrder({
      userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1'),
    });

    expect(order.status).toBe('filled');
    expect(trades).toHaveLength(1);
    // bob is taker: pays 2000 + 0.20% = 2004, and gets the 0.10% over-reservation back
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: usdt('2996'), locked: 0n });
    expect(await ledger.balanceOf('bob', 'ETH')).toEqual({ available: qty('1'), locked: 0n });
    // sam is maker: receives 2000 - 0.10% = 1998
    expect(await ledger.balanceOf('sam', 'USDT')).toEqual({ available: usdt('1998'), locked: 0n });
    expect(await ledger.balanceOf('sam', 'ETH')).toEqual({ available: 0n, locked: 0n });
    expect(await store.getBalance(feesAccount('USDT'))).toBe(usdt('6'));
    expect((await checkInvariants(store)).violations).toEqual([]);
  });

  it('refunds price improvement when a buy fills below its limit', async () => {
    const { exchange, ledger, fund } = setup();
    await fund('sam', 'ETH', qty('1'));
    await fund('bob', 'USDT', usdt('5000'));

    await exchange.placeOrder({ userId: 'sam', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('1900'), qty: qty('1') });
    await exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1') });

    // Trades at the maker price 1900, plus 3.8 taker fee
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: usdt('3096.2'), locked: 0n });
  });

  it('keeps the remainder of a partial fill on the book and unlocks it on cancel', async () => {
    const { exchange, ledger, store, fund } = setup();
    await fund('sam', 'ETH', qty('0.4'));
    await fund('bob', 'USDT', usdt('5000'));

    await exchange.placeOrder({ userId: 'sam', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2000'), qty: qty('0.4') });
    const { order } = await exchange.placeOrder({
      userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1'),
    });

    expect(order).toMatchObject({ status: 'open', filled: qty('0.4') });
    expect(exchange.book('ETH-USDT').bids).toEqual([[px('2000'), qty('0.6')]]);
    // 0.6 ETH still reserved at 2000 + 0.20%
    expect((await ledger.balanceOf('bob', 'USDT')).locked).toBe(usdt('1202.4'));

    const cancelled = await exchange.cancelOrder('bob', order.id);
    expect(cancelled.status).toBe('cancelled');
    expect(exchange.book('ETH-USDT').bids).toEqual([]);
    // paid 800 + 1.6 taker fee for the 0.4 that filled, the rest is back
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: usdt('4198.4'), locked: 0n });
    expect((await checkInvariants(store)).violations).toEqual([]);
  });

  it('fills makers at the same price in time order (FIFO)', async () => {
    const { exchange, fund } = setup();
    for (const u of ['s1', 's2', 's3']) await fund(u, 'ETH', qty('1'));
    await fund('bob', 'USDT', usdt('5000'));
    const ids: string[] = [];
    for (const u of ['s1', 's2', 's3']) {
      const { order } = await exchange.placeOrder({ userId: u, market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2000'), qty: qty('1') });
      ids.push(order.id);
    }

    const { trades } = await exchange.placeOrder({
      userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1.5'),
    });
    expect(trades.map((t) => [t.makerOrderId, t.qty])).toEqual([
      [ids[0], qty('1')],
      [ids[1], qty('0.5')],
    ]);
    expect(exchange.getOrder(ids[1]!)).toMatchObject({ status: 'open', filled: qty('0.5') });
    expect(exchange.getOrder(ids[2]!)).toMatchObject({ status: 'open', filled: 0n });
  });

  it('sweeps several levels with a market buy and reserves the exact sweep cost', async () => {
    const { exchange, ledger, store, fund } = setup();
    await fund('s1', 'ETH', qty('1'));
    await fund('s2', 'ETH', qty('1'));
    await fund('bob', 'USDT', usdt('10000'));
    await exchange.placeOrder({ userId: 's1', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2000'), qty: qty('1') });
    await exchange.placeOrder({ userId: 's2', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2010'), qty: qty('1') });

    const { order, trades } = await exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'market', qty: qty('1.5') });

    expect(order.status).toBe('filled');
    expect(trades.map((t) => t.price)).toEqual([px('2000'), px('2010')]);
    // 2000 + 1005 = 3005 notional, + 0.20% taker = 6.01
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: usdt('6988.99'), locked: 0n });
    expect(exchange.book('ETH-USDT').asks).toEqual([[px('2010'), qty('0.5')]]);
    expect((await checkInvariants(store)).violations).toEqual([]);
  });

  it('rejects a market order when the other side of the book is empty', async () => {
    const { exchange, fund } = setup();
    await fund('bob', 'USDT', usdt('1000'));
    await expect(
      exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'market', qty: qty('1') }),
    ).rejects.toMatchObject({ code: 'NO_LIQUIDITY' });
  });

  it('prevents self-trades by cancelling the taker remainder and releasing its funds', async () => {
    const { exchange, ledger, fund } = setup();
    await fund('alice', 'ETH', qty('1'));
    await fund('alice', 'USDT', usdt('5000'));
    await exchange.placeOrder({ userId: 'alice', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2000'), qty: qty('1') });

    const { order, trades } = await exchange.placeOrder({
      userId: 'alice', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1'),
    });

    expect(trades).toEqual([]);
    expect(order.status).toBe('cancelled');
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: usdt('5000'), locked: 0n });
    expect(exchange.book('ETH-USDT').asks).toEqual([[px('2000'), qty('1')]]);
  });

  it('only lets the owner cancel, and only once', async () => {
    const { exchange, fund } = setup();
    await fund('bob', 'USDT', usdt('5000'));
    const { order } = await exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1') });

    await expect(exchange.cancelOrder('mallory', order.id)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await exchange.cancelOrder('bob', order.id);
    await expect(exchange.cancelOrder('bob', order.id)).rejects.toMatchObject({ code: 'ORDER_NOT_OPEN' });
  });

  it('emits trades and book deltas', async () => {
    const { exchange, fund } = setup();
    await fund('sam', 'ETH', qty('1'));
    await fund('bob', 'USDT', usdt('5000'));
    const events: ExchangeEvent[] = [];
    exchange.subscribe((e) => events.push(e));

    await exchange.placeOrder({ userId: 'sam', market: 'ETH-USDT', side: 'sell', type: 'limit', price: px('2000'), qty: qty('1') });
    await exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('0.25') });

    expect(events).toEqual([
      { type: 'book', market: 'ETH-USDT', side: 'sell', price: px('2000'), qty: qty('1') },
      { type: 'trade', trade: expect.objectContaining({ price: px('2000'), qty: qty('0.25'), takerSide: 'buy' }) },
      { type: 'book', market: 'ETH-USDT', side: 'sell', price: px('2000'), qty: qty('0.75') },
    ]);
  });

  it('serializes concurrent orders so two buys cannot spend the same balance', async () => {
    const { exchange, ledger, fund } = setup();
    await fund('bob', 'USDT', usdt('2004'));
    const place = () =>
      exchange.placeOrder({ userId: 'bob', market: 'ETH-USDT', side: 'buy', type: 'limit', price: px('2000'), qty: qty('1') });

    const results = await Promise.allSettled([place(), place()]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: 0n, locked: usdt('2004') });
  });

  it('rebuilds the same book and trades by replaying the command log', async () => {
    const { exchange, store, fund } = setup();
    const users = ['u1', 'u2', 'u3', 'u4'];
    for (const u of users) {
      await fund(u, 'ETH', qty('100'));
      await fund(u, 'USDT', usdt('1000000'));
    }

    // A deterministic but busy sequence: crossing limits, market orders, cancels, a self-trade.
    const liveTrades: string[] = [];
    const open: Array<{ user: string; id: string }> = [];
    for (let i = 0; i < 120; i++) {
      const user = users[i % users.length]!;
      const side = (i * 7) % 3 === 0 ? 'buy' : 'sell';
      if (i % 11 === 10 && open.length > 0) {
        const victim = open.splice(i % open.length, 1)[0]!;
        await exchange.cancelOrder(victim.user, victim.id).catch(() => undefined);
        continue;
      }
      const type = i % 9 === 8 ? 'market' : 'limit';
      const price = px(String(1990 + ((i * 13) % 21)));
      const res = await exchange
        .placeOrder({ userId: user, market: 'ETH-USDT', side, type, ...(type === 'limit' && { price }), qty: qty(`0.${1 + (i % 9)}`) })
        .catch(() => undefined);
      if (!res) continue;
      liveTrades.push(...res.trades.map((t) => `${t.makerOrderId}>${t.takerOrderId}@${t.price}x${t.qty}`));
      if (res.order.status === 'open') open.push({ user, id: res.order.id });
    }

    const { engine, fills } = replay(exchange.commandLog('ETH-USDT'), ETH_USDT);
    expect(engine.book(1000)).toEqual(exchange.book('ETH-USDT', 1000));
    expect(fills.map((f) => `${f.makerOrderId}>${f.takerOrderId}@${f.price}x${f.qty}`)).toEqual(liveTrades);
    expect(liveTrades.length).toBeGreaterThan(10);
    expect((await checkInvariants(store)).violations).toEqual([]);
  });
});
