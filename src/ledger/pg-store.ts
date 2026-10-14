import pg from 'pg';
import { mayGoNegative } from './accounts.js';
import { assertNoOverdraft, fingerprint, netDeltas } from './entry.js';
import {
  IdempotencyConflictError,
  type AccountBalance,
  type EntryKind,
  type JournalEntry,
  type LedgerStore,
  type PostResult,
  type PostedEntry,
} from './types.js';

type Queryable = Pick<pg.Pool, 'query' | 'connect'>;

/**
 * Postgres store. One `post` is one transaction:
 *   1. insert the entry header; the UNIQUE idempotency key makes a concurrent retry wait
 *      for the first attempt and then see it as a duplicate,
 *   2. lock the affected balance rows with SELECT ... FOR UPDATE in account id order, so
 *      two entries touching the same accounts can never deadlock,
 *   3. check overdrafts against the locked values, write postings and new balances.
 * READ COMMITTED is enough here because every row we decide on is locked first.
 */
export class PgLedgerStore implements LedgerStore {
  constructor(private readonly pool: Queryable) {}

  async post(entry: JournalEntry): Promise<PostResult> {
    const fp = fingerprint(entry);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ledger_entries (idempotency_key, kind, ref, fingerprint)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [entry.idempotencyKey, entry.kind, entry.ref ?? null, fp],
      );

      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return { entry: await this.loadEntry(entry.idempotencyKey, fp), duplicate: true };
      }
      const entryId = Number(inserted.rows[0]!.id);

      const deltas = netDeltas(entry.postings);
      const ids = deltas.map((d) => d.accountId);

      // Make sure every row exists before locking; ON CONFLICT keeps this race-free.
      await client.query(
        `INSERT INTO ledger_accounts (id, asset, may_go_negative)
         SELECT * FROM unnest($1::text[], $2::text[], $3::boolean[])
         ON CONFLICT (id) DO NOTHING`,
        [ids, deltas.map((d) => d.asset), ids.map(mayGoNegative)],
      );

      const locked = await client.query<{ id: string; balance: string }>(
        `SELECT id, balance FROM ledger_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [ids],
      );
      const current = new Map(locked.rows.map((r) => [r.id, BigInt(r.balance)]));

      for (const d of deltas) assertNoOverdraft(d.accountId, current.get(d.accountId) ?? 0n, d.delta);

      for (const d of deltas) {
        await client.query(
          `UPDATE ledger_accounts SET balance = balance + $2::numeric, updated_at = now() WHERE id = $1`,
          [d.accountId, d.delta.toString()],
        );
      }
      await client.query(
        `INSERT INTO ledger_postings (entry_id, account_id, asset, amount)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::numeric[])`,
        [
          entryId,
          entry.postings.map((p) => p.accountId),
          entry.postings.map((p) => p.asset),
          entry.postings.map((p) => p.amount.toString()),
        ],
      );

      await client.query('COMMIT');
      return { entry: { ...entry, id: entryId }, duplicate: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getBalance(accountId: string): Promise<bigint> {
    const res = await this.pool.query<{ balance: string }>(`SELECT balance FROM ledger_accounts WHERE id = $1`, [
      accountId,
    ]);
    return res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
  }

  async listBalances(prefix = ''): Promise<AccountBalance[]> {
    // starts_with avoids LIKE so user ids containing "_" or "%" cannot widen the match.
    const res = await this.pool.query<{ id: string; asset: string; balance: string }>(
      `SELECT id, asset, balance FROM ledger_accounts WHERE starts_with(id, $1) ORDER BY id`,
      [prefix],
    );
    return res.rows.map((r) => ({ accountId: r.id, asset: r.asset, balance: BigInt(r.balance) }));
  }

  async sumPostingsByAccount(): Promise<Map<string, bigint>> {
    const res = await this.pool.query<{ account_id: string; total: string }>(
      `SELECT account_id, SUM(amount) AS total FROM ledger_postings GROUP BY account_id`,
    );
    return new Map(res.rows.map((r) => [r.account_id, BigInt(r.total)]));
  }

  private async loadEntry(idempotencyKey: string, expectedFingerprint: string): Promise<PostedEntry> {
    const head = await this.pool.query<{ id: string; kind: EntryKind; ref: string | null; fingerprint: string }>(
      `SELECT id, kind, ref, fingerprint FROM ledger_entries WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = head.rows[0];
    if (!row) throw new Error(`entry ${idempotencyKey} vanished`);
    if (row.fingerprint !== expectedFingerprint) throw new IdempotencyConflictError(idempotencyKey);

    const legs = await this.pool.query<{ account_id: string; asset: string; amount: string }>(
      `SELECT account_id, asset, amount FROM ledger_postings WHERE entry_id = $1 ORDER BY id`,
      [row.id],
    );
    return {
      id: Number(row.id),
      idempotencyKey,
      kind: row.kind,
      ...(row.ref !== null && { ref: row.ref }),
      postings: legs.rows.map((l) => ({ accountId: l.account_id, asset: l.asset, amount: BigInt(l.amount) })),
    };
  }
}
