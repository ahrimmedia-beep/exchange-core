import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Withdrawal } from '../custody/withdrawals.js';
import type { ExchangeEvent, OrderView, TradeView } from '../exchange/exchange-service.js';
import { priceFromEngine, priceToEngine, qtyFromEngine, qtyToEngine, type Market } from '../exchange/market.js';
import { fromUnits, toUnits } from '../ledger/money.js';
import type { BookLevel, OrderType, Side } from '../matching/types.js';
import { createCore, type Core } from './context.js';
import { HttpError, toHttpError } from './errors.js';
import { IdempotencyCache, type StoredResponse } from './idempotency.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export interface AppOptions {
  core?: Core;
  /** User ids allowed to call /admin routes. Demo stand-in for real roles. */
  admins?: string[];
  logger?: boolean;
}

const DECIMAL = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$', maxLength: 80 } as const;
const USER_ID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

interface PlaceOrderBody {
  market: string;
  side: Side;
  type: OrderType;
  price?: string;
  quantity: string;
}

interface WithdrawalBody {
  asset: string;
  amount: string;
  to: string;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const core = options.core ?? createCore();
  const admins = new Set(options.admins ?? ['admin']);
  const idempotency = new IdempotencyCache();
  const app = Fastify({
    logger: options.logger ?? false,
    // No type coercion: a JSON number like 0.1 must be rejected, not quietly turned into
    // the string "0.1". Amounts only travel as decimal strings.
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.decorateRequest('userId', '');

  /**
   * DEMO AUTH ONLY. Trusts the `x-user-id` header so the API can be exercised with curl.
   * A real deployment replaces this hook with session or JWT verification; nothing else
   * in the code depends on how the user id was obtained.
   */
  async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers['x-user-id'];
    if (typeof header !== 'string' || !USER_ID_RE.test(header)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'x-user-id header required (demo auth)');
    }
    req.userId = header;
  }

  async function requireAdmin(req: FastifyRequest): Promise<void> {
    await authenticate(req);
    if (!admins.has(req.userId)) throw new HttpError(403, 'FORBIDDEN', 'admin only');
  }

  app.setErrorHandler((err, req, reply) => {
    const http = toHttpError(err);
    if (http.statusCode >= 500) req.log.error(err);
    void reply.status(http.statusCode).send({ error: { code: http.code, message: http.message } });
  });

  /** Runs a mutating handler under the Idempotency-Key header, when one is given. */
  async function idempotent(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: { required: boolean },
    handler: (key: string | undefined) => Promise<StoredResponse>,
  ): Promise<unknown> {
    const key = req.headers['idempotency-key'];
    if (key === undefined) {
      if (opts.required) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
      const res = await handler(undefined);
      return reply.status(res.status).send(res.body);
    }
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-128 characters');
    }
    const fingerprint = JSON.stringify([req.method, req.routeOptions.url, req.params, req.body]);
    const res = await idempotency.run(req.userId, key, fingerprint, () => handler(key));
    if (res.replayed) void reply.header('idempotent-replayed', 'true');
    return reply.status(res.status).send(res.body);
  }

  // ---- orders --------------------------------------------------------------------------

  app.post<{ Body: PlaceOrderBody }>(
    '/orders',
    {
      onRequest: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['market', 'side', 'type', 'quantity'],
          properties: {
            market: { type: 'string', maxLength: 32 },
            side: { type: 'string', enum: ['buy', 'sell'] },
            type: { type: 'string', enum: ['limit', 'market'] },
            price: DECIMAL,
            quantity: DECIMAL,
          },
        },
      },
    },
    (req, reply) =>
      idempotent(req, reply, { required: false }, async () => {
        const { market: symbol, side, type, price, quantity } = req.body;
        const market = core.exchange.market(symbol);
        if (type === 'limit' && price === undefined) throw new HttpError(400, 'MISSING_PRICE', 'limit orders need a price');
        const { order, trades } = await core.exchange.placeOrder({
          userId: req.userId,
          market: symbol,
          side,
          type,
          ...(price !== undefined && { price: priceToEngine(market, price) }),
          qty: qtyToEngine(market, quantity),
        });
        return { status: 201, body: { order: orderJson(market, order), trades: trades.map((t) => tradeJson(market, t)) } };
      }),
  );

  app.delete<{ Params: { id: string } }>('/orders/:id', { onRequest: authenticate }, async (req) => {
    const order = await core.exchange.cancelOrder(req.userId, req.params.id);
    return { order: orderJson(core.exchange.market(order.market), order) };
  });

  // ---- market data ---------------------------------------------------------------------

  app.get<{ Params: { market: string }; Querystring: { depth?: string } }>(
    '/markets/:market/book',
    { schema: { querystring: { type: 'object', properties: { depth: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' } } } } },
    async (req) => {
      const market = core.exchange.market(req.params.market);
      const book = core.exchange.book(market.market, Number(req.query.depth ?? 50));
      return { market: market.market, bids: levelsJson(market, book.bids), asks: levelsJson(market, book.asks) };
    },
  );

  // ---- accounts ------------------------------------------------------------------------

  app.get<{ Params: { user: string } }>('/accounts/:user/balances', { onRequest: authenticate }, async (req) => {
    if (req.params.user !== req.userId && !admins.has(req.userId)) {
      throw new HttpError(403, 'FORBIDDEN', 'you can only read your own balances');
    }
    const balances = await core.ledger.balances(req.params.user);
    const out: Record<string, { available: string; locked: string }> = {};
    for (const [asset, b] of Object.entries(balances)) {
      const decimals = core.ledger.decimals(asset);
      out[asset] = { available: fromUnits(b.available, decimals), locked: fromUnits(b.locked, decimals) };
    }
    return { user: req.params.user, balances: out };
  });

  // ---- withdrawals ---------------------------------------------------------------------

  /** Auto-approved withdrawals go straight to the signer; the result is the latest state. */
  async function dispatch(w: Withdrawal): Promise<Withdrawal> {
    if (w.status !== 'approved') return w;
    try {
      return await core.withdrawals.process(w.id);
    } catch (err) {
      // Broadcast failures leave the withdrawal `signed`; a background job retries it.
      app.log.warn({ err, withdrawalId: w.id }, 'withdrawal dispatch failed');
      return core.withdrawals.get(w.id);
    }
  }

  app.post<{ Body: WithdrawalBody }>(
    '/withdrawals',
    {
      onRequest: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['asset', 'amount', 'to'],
          properties: {
            asset: { type: 'string', maxLength: 16 },
            amount: DECIMAL,
            to: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    (req, reply) =>
      idempotent(req, reply, { required: true }, async (key) => {
        const { asset, amount, to } = req.body;
        const requested = await core.withdrawals.request({
          userId: req.userId,
          asset,
          amount: toUnits(amount, core.ledger.decimals(asset)),
          to,
          idempotencyKey: key!,
        });
        return { status: 201, body: { withdrawal: withdrawalJson(core, await dispatch(requested)) } };
      }),
  );

  app.post<{ Params: { id: string } }>('/admin/withdrawals/:id/approve', { onRequest: requireAdmin }, async (req) => {
    const approved = core.withdrawals.approve(req.params.id, req.userId);
    return { withdrawal: withdrawalJson(core, await dispatch(approved)) };
  });

  // ---- live stream ---------------------------------------------------------------------

  await app.register(websocket);
  app.register(async (scope) => {
    scope.get<{ Querystring: { market?: string } }>('/ws', { websocket: true }, (socket, req) => {
      const symbol = req.query.market ?? '';
      let market: Market;
      try {
        market = core.exchange.market(symbol);
      } catch {
        socket.close(1008, 'unknown market');
        return;
      }

      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const book = core.exchange.book(market.market);
      send({ type: 'snapshot', market: market.market, bids: levelsJson(market, book.bids), asks: levelsJson(market, book.asks) });

      const unsubscribe = core.exchange.subscribe((event: ExchangeEvent) => {
        if (event.type === 'book' && event.market === market.market) {
          send({
            type: 'book',
            market: market.market,
            side: event.side,
            price: priceFromEngine(market, event.price),
            quantity: qtyFromEngine(market, event.qty),
          });
        } else if (event.type === 'trade' && event.trade.market === market.market) {
          send({ type: 'trade', ...tradeJson(market, event.trade) });
        }
      });
      socket.on('close', unsubscribe);
    });
  });

  return app;
}

// ---- JSON views: bigint never leaves the process as a number ---------------------------

function orderJson(market: Market, o: OrderView) {
  return {
    id: o.id,
    market: o.market,
    side: o.side,
    type: o.type,
    ...(o.price !== undefined && { price: priceFromEngine(market, o.price) }),
    quantity: qtyFromEngine(market, o.qty),
    filled: qtyFromEngine(market, o.filled),
    status: o.status,
  };
}

function tradeJson(market: Market, t: TradeView) {
  return {
    id: t.id,
    market: t.market,
    price: priceFromEngine(market, t.price),
    quantity: qtyFromEngine(market, t.qty),
    takerSide: t.takerSide,
  };
}

function levelsJson(market: Market, levels: BookLevel[]): Array<[string, string]> {
  return levels.map(([p, q]) => [priceFromEngine(market, p), qtyFromEngine(market, q)]);
}

function withdrawalJson(core: Core, w: Withdrawal) {
  return {
    id: w.id,
    asset: w.asset,
    amount: fromUnits(w.amount, core.ledger.decimals(w.asset)),
    to: w.to,
    status: w.status,
    createdAt: w.createdAt.toISOString(),
    ...(w.txHash && { txHash: w.txHash }),
    ...(w.reason && { reason: w.reason }),
  };
}
