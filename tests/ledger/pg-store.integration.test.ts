import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InsufficientFundsError, Ledger, checkInvariants } from '../../src/ledger/index.js';
import { PgLedgerStore } from '../../src/ledger/pg-store.js';

const url = process.env.DATABASE_URL;

// Runs only against a real database: `docker compose up -d` then DATABASE_URL=... pnpm test.
describe.skipIf(!url)('PgLedgerStore (integration)', () => {
  let pool: pg.Pool;
  let store: PgLedgerStore;
  let ledger: Ledger;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query(readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8'));
    // The append-only trigger guards UPDATE and DELETE, not TRUNCATE, so tests can start clean.
    await pool.query('TRUNCATE ledger_postings, ledger_entries, ledger_accounts RESTART IDENTITY');
    store = new PgLedgerStore(pool);
    ledger = new Ledger(store, { USDT: { decimals: 6 } });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('applies entries, honours idempotency and rejects overdrafts', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 100n, idempotencyKey: 'pg-d1' });
    const dup = await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 100n, idempotencyKey: 'pg-d1' });
    expect(dup.duplicate).toBe(true);
    expect(dup.entry.postings).toHaveLength(2);

    await expect(
      ledger.lock({ userId: 'alice', asset: 'USDT', amount: 101n, idempotencyKey: 'pg-l1' }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 100n, locked: 0n });
  });

  it('serializes concurrent spends of the same balance with row locks', async () => {
    await ledger.deposit({ userId: 'bob', asset: 'USDT', amount: 10n, idempotencyKey: 'pg-d2' });
    // Ten concurrent locks of 3 against a balance of 10: exactly three may succeed.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ledger.lock({ userId: 'bob', asset: 'USDT', amount: 3n, idempotencyKey: `pg-race-${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: 1n, locked: 9n });
    expect((await checkInvariants(store)).violations).toEqual([]);
  });
});
