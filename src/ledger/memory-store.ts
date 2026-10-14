import { assertNoOverdraft, fingerprint, netDeltas } from './entry.js';
import {
  IdempotencyConflictError,
  type AccountBalance,
  type JournalEntry,
  type LedgerStore,
  type PostResult,
  type PostedEntry,
} from './types.js';

/**
 * In-memory store for tests and the demo server. `post` has no await between the checks
 * and the writes, so on a single Node thread it is as atomic as a database transaction.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly balances = new Map<string, AccountBalance>();
  private readonly entries: PostedEntry[] = [];
  private readonly byKey = new Map<string, { entry: PostedEntry; fingerprint: string }>();

  async post(entry: JournalEntry): Promise<PostResult> {
    const fp = fingerprint(entry);
    const existing = this.byKey.get(entry.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fp) throw new IdempotencyConflictError(entry.idempotencyKey);
      return { entry: existing.entry, duplicate: true };
    }

    const deltas = netDeltas(entry.postings);
    // Check every leg first, then write. A failing leg must leave all balances untouched.
    for (const d of deltas) {
      assertNoOverdraft(d.accountId, this.balances.get(d.accountId)?.balance ?? 0n, d.delta);
    }
    for (const d of deltas) {
      const row = this.balances.get(d.accountId) ?? { accountId: d.accountId, asset: d.asset, balance: 0n };
      row.balance += d.delta;
      this.balances.set(d.accountId, row);
    }

    const posted: PostedEntry = {
      ...entry,
      postings: entry.postings.map((p) => ({ ...p })),
      id: this.entries.length + 1,
    };
    this.entries.push(posted);
    this.byKey.set(entry.idempotencyKey, { entry: posted, fingerprint: fp });
    return { entry: posted, duplicate: false };
  }

  async getBalance(accountId: string): Promise<bigint> {
    return this.balances.get(accountId)?.balance ?? 0n;
  }

  async listBalances(prefix = ''): Promise<AccountBalance[]> {
    return [...this.balances.values()]
      .filter((b) => b.accountId.startsWith(prefix))
      .map((b) => ({ ...b }));
  }

  async sumPostingsByAccount(): Promise<Map<string, bigint>> {
    const sums = new Map<string, bigint>();
    for (const e of this.entries) {
      for (const p of e.postings) sums.set(p.accountId, (sums.get(p.accountId) ?? 0n) + p.amount);
    }
    return sums;
  }

  /** Test helper: total number of journal entries written. */
  get entryCount(): number {
    return this.entries.length;
  }
}
