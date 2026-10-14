import { describe, expect, it } from 'vitest';
import { InMemoryLedgerStore, InsufficientFundsError, Ledger, checkInvariants } from '../../src/ledger/index.js';

/** Small seeded PRNG so a failing run can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = ['u1', 'u2', 'u3', 'u4'];
const ASSETS = { ETH: { decimals: 18 }, USDT: { decimals: 6 } };

describe('Ledger property: random operations keep the books balanced', () => {
  for (const seed of [1, 7, 42, 1337, 2026]) {
    it(`seed ${seed}`, async () => {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const amount = () => BigInt(1 + Math.floor(rnd() * 1_000));

      const store = new InMemoryLedgerStore();
      const ledger = new Ledger(store, ASSETS);
      const keys: Array<() => Promise<unknown>> = [];
      let rejected = 0;

      for (let i = 0; i < 400; i++) {
        const user = pick(USERS);
        const asset = pick(['ETH', 'USDT'] as const);
        const key = `op-${i}`;
        const op = pick(['deposit', 'lock', 'unlock', 'trade', 'wreq', 'wfail', 'wdone', 'retry'] as const);

        // Draw every random value up front so a retry replays exactly the same call.
        const amt = amount();
        const quoteQty = amount();
        const sellerFee = BigInt(Math.floor(rnd() * Number(quoteQty) * 0.01));
        const buyerFee = BigInt(Math.floor(rnd() * 3));
        const counterparty = pick(USERS.filter((u) => u !== user));
        const earlier = keys.length ? pick(keys) : undefined;
        const m = { userId: user, asset, amount: amt, idempotencyKey: key };

        const run = (): Promise<unknown> => {
          switch (op) {
            case 'deposit':
              return ledger.deposit({ ...m, amount: amt * 10n });
            case 'lock':
              return ledger.lock(m);
            case 'unlock':
              return ledger.unlock(m);
            case 'wreq':
              return ledger.requestWithdrawal(m);
            case 'wfail':
              return ledger.failWithdrawal(m);
            case 'wdone':
              return ledger.completeWithdrawal(m);
            case 'trade':
              return ledger.settleTrade({
                idempotencyKey: key,
                base: 'ETH',
                quote: 'USDT',
                buyerId: user,
                sellerId: counterparty,
                baseQty: amt,
                quoteQty,
                buyerFee,
                sellerFee,
              });
            case 'retry':
              // Replaying an earlier successful call must be a no-op.
              return earlier ? earlier() : Promise.resolve();
          }
        };

        const before = await store.listBalances();
        try {
          await run();
          if (op === 'retry') expect(await store.listBalances()).toEqual(before);
          else keys.push(run);
        } catch (err) {
          expect(err).toBeInstanceOf(InsufficientFundsError);
          rejected++;
          // A rejected operation must not change a single balance.
          expect(await store.listBalances()).toEqual(before);
        }

        if (i % 25 === 0) expect((await checkInvariants(store)).violations).toEqual([]);
      }

      const final = await checkInvariants(store);
      expect(final.violations).toEqual([]);
      // Sanity: the generator exercised both paths.
      expect(rejected).toBeGreaterThan(0);
      expect(store.entryCount).toBeGreaterThan(50);
    });
  }
});
