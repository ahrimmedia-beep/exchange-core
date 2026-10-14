import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createCore, type Core } from '../../src/api/context.js';
import { toUnits } from '../../src/ledger/money.js';

const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

describe('HTTP API', () => {
  let core: Core;
  let app: FastifyInstance;

  beforeEach(async () => {
    core = createCore();
    app = await buildApp({ core });
    for (const [userId, asset, amount] of [
      ['alice', 'USDT', '50000'],
      ['bob', 'ETH', '20'],
    ] as const) {
      await core.ledger.deposit({
        userId,
        asset,
        amount: toUnits(amount, core.ledger.decimals(asset)),
        idempotencyKey: `seed:${userId}:${asset}`,
      });
    }
  });

  afterEach(() => app.close());

  const post = (url: string, user: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers: { 'x-user-id': user, ...headers } });
  const balances = async (user: string) =>
    (await app.inject({ method: 'GET', url: `/accounts/${user}/balances`, headers: { 'x-user-id': user } })).json()
      .balances;

  it('places orders, matches them and shows the result in balances and the book', async () => {
    const ask = await post('/orders', 'bob', { market: 'ETH-USDT', side: 'sell', type: 'limit', price: '2000', quantity: '1.5' });
    expect(ask.statusCode).toBe(201);
    expect(ask.json().order).toMatchObject({ status: 'open', price: '2000', quantity: '1.5', filled: '0' });

    const bid = await post('/orders', 'alice', { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '2000', quantity: '1' });
    expect(bid.statusCode).toBe(201);
    expect(bid.json().order.status).toBe('filled');
    expect(bid.json().trades).toEqual([expect.objectContaining({ price: '2000', quantity: '1', takerSide: 'buy' })]);

    const book = await app.inject({ method: 'GET', url: '/markets/ETH-USDT/book?depth=10' });
    expect(book.json()).toEqual({ market: 'ETH-USDT', bids: [], asks: [['2000', '0.5']] });

    // 50000 - 2000 - 0.20% taker fee
    expect(await balances('alice')).toEqual({
      USDT: { available: '47996', locked: '0' },
      ETH: { available: '1', locked: '0' },
    });
  });

  it('honours Idempotency-Key on order placement', async () => {
    const body = { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '1000', quantity: '1' };
    const first = await post('/orders', 'alice', body, { 'idempotency-key': 'abc' });
    const retry = await post('/orders', 'alice', body, { 'idempotency-key': 'abc' });

    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(core.exchange.book('ETH-USDT').bids).toHaveLength(1);
    expect((await balances('alice')).USDT.locked).toBe('1002');

    const reused = await post('/orders', 'alice', { ...body, quantity: '2' }, { 'idempotency-key': 'abc' });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects bad input, missing auth and insufficient funds with clear errors', async () => {
    const noAuth = await app.inject({ method: 'POST', url: '/orders', payload: {} });
    expect(noAuth.statusCode).toBe(401);

    const invalid = await post('/orders', 'alice', { market: 'ETH-USDT', side: 'up', type: 'limit', quantity: '1' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION_ERROR');

    const float = await post('/orders', 'alice', { market: 'ETH-USDT', side: 'buy', type: 'limit', price: 2000, quantity: '1' });
    expect(float.statusCode).toBe(400);

    const tick = await post('/orders', 'alice', { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '2000.001', quantity: '1' });
    expect(tick.statusCode).toBe(400);

    const broke = await post('/orders', 'alice', { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '2000', quantity: '100' });
    expect(broke.statusCode).toBe(422);
    expect(broke.json().error.code).toBe('INSUFFICIENT_FUNDS');

    const unknown = await post('/orders', 'alice', { market: 'DOGE-USDT', side: 'buy', type: 'limit', price: '1', quantity: '1' });
    expect(unknown.statusCode).toBe(404);
  });

  it('cancels an order and returns the funds', async () => {
    const placed = await post('/orders', 'alice', { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '1000', quantity: '2' });
    const id = placed.json().order.id as string;

    const notMine = await app.inject({ method: 'DELETE', url: `/orders/${id}`, headers: { 'x-user-id': 'bob' } });
    expect(notMine.statusCode).toBe(404);

    const res = await app.inject({ method: 'DELETE', url: `/orders/${id}`, headers: { 'x-user-id': 'alice' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.status).toBe('cancelled');
    expect((await balances('alice')).USDT).toEqual({ available: '50000', locked: '0' });
  });

  it('does not show balances of another user', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounts/alice/balances', headers: { 'x-user-id': 'bob' } });
    expect(res.statusCode).toBe(403);
  });

  it('runs a small withdrawal straight through and a large one via admin approval', async () => {
    const small = await post('/withdrawals', 'alice', { asset: 'USDT', amount: '100', to: RECIPIENT }, { 'idempotency-key': 'w-1' });
    expect(small.statusCode).toBe(201);
    expect(small.json().withdrawal).toMatchObject({ status: 'broadcast', amount: '100' });

    const big = await post('/withdrawals', 'alice', { asset: 'USDT', amount: '20000', to: RECIPIENT }, { 'idempotency-key': 'w-2' });
    expect(big.json().withdrawal.status).toBe('pending_approval');
    expect((await balances('alice')).USDT).toEqual({ available: '29900', locked: '20100' });

    const id = big.json().withdrawal.id as string;
    const byUser = await post(`/admin/withdrawals/${id}/approve`, 'alice', {});
    expect(byUser.statusCode).toBe(403);

    const approved = await post(`/admin/withdrawals/${id}/approve`, 'admin', {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json().withdrawal.status).toBe('broadcast');
  });

  it('requires and honours Idempotency-Key on withdrawals', async () => {
    const body = { asset: 'USDT', amount: '10', to: RECIPIENT };
    expect((await post('/withdrawals', 'alice', body)).statusCode).toBe(400);

    const a = await post('/withdrawals', 'alice', body, { 'idempotency-key': 'once' });
    const b = await post('/withdrawals', 'alice', body, { 'idempotency-key': 'once' });
    expect(b.json()).toEqual(a.json());
    expect((await balances('alice')).USDT.locked).toBe('10');
  });

  it('rejects a withdrawal to a malformed address', async () => {
    const res = await post(
      '/withdrawals',
      'alice',
      { asset: 'USDT', amount: '10', to: '0x000000000000000000000000000000000000DEAD' },
      { 'idempotency-key': 'bad-addr' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ADDRESS');
  });
});

describe('WebSocket stream', () => {
  it('sends a snapshot, then book deltas and trades for the market', async () => {
    const core = createCore();
    const app = await buildApp({ core });
    await core.ledger.deposit({ userId: 'bob', asset: 'ETH', amount: 10n ** 18n, idempotencyKey: 's1' });
    await core.ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 10_000n * 10n ** 6n, idempotencyKey: 's2' });
    await app.ready();

    const messages: Array<Record<string, unknown>> = [];
    let snapshotSeen!: () => void;
    let tradeSeen!: () => void;
    const snapshot = new Promise<void>((r) => (snapshotSeen = r));
    const trade = new Promise<void>((r) => (tradeSeen = r));
    // Listen from onInit so the snapshot sent right after the upgrade is not missed.
    const ws = await app.injectWS('/ws?market=ETH-USDT', {}, {
      onInit: (socket) =>
        socket.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          messages.push(msg);
          if (msg.type === 'snapshot') snapshotSeen();
          if (msg.type === 'book' && msg.quantity === '0.6') tradeSeen();
        }),
    });
    await snapshot;

    const order = (user: string, side: string) =>
      app.inject({
        method: 'POST',
        url: '/orders',
        headers: { 'x-user-id': user },
        payload: { market: 'ETH-USDT', side, type: 'limit', price: '2500', quantity: side === 'sell' ? '1' : '0.4' },
      });
    await order('bob', 'sell');
    await order('alice', 'buy');
    await trade;

    expect(messages).toEqual([
      { type: 'snapshot', market: 'ETH-USDT', bids: [], asks: [] },
      { type: 'book', market: 'ETH-USDT', side: 'sell', price: '2500', quantity: '1' },
      expect.objectContaining({ type: 'trade', price: '2500', quantity: '0.4', takerSide: 'buy' }),
      { type: 'book', market: 'ETH-USDT', side: 'sell', price: '2500', quantity: '0.6' },
    ]);

    ws.terminate();
    await app.close();
  });
});
