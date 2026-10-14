import { buildApp } from './api/app.js';
import { createCore } from './api/context.js';
import { toUnits } from './ledger/money.js';

/**
 * Demo entry point: in-memory stores, fake signer, and two pre-funded users so the API
 * can be tried right away, e.g.
 *
 *   curl -s localhost:3000/accounts/alice/balances -H 'x-user-id: alice'
 */
const core = createCore();
for (const [userId, asset, amount] of [
  ['alice', 'USDT', '100000'],
  ['alice', 'ETH', '10'],
  ['bob', 'USDT', '100000'],
  ['bob', 'ETH', '10'],
] as const) {
  await core.ledger.deposit({
    userId,
    asset,
    amount: toUnits(amount, core.ledger.decimals(asset)),
    idempotencyKey: `demo-seed:${userId}:${asset}`,
  });
}

const app = await buildApp({ core, logger: true });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
