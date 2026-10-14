import { assetOf, mayGoNegative } from './accounts.js';
import {
  InsufficientFundsError,
  InvalidEntryError,
  type JournalEntry,
  type Posting,
} from './types.js';

/**
 * Structural checks shared by every store: non-zero legs, account and asset agree, and the
 * legs of each asset sum to exactly zero. An entry that fails here never reaches storage.
 */
export function validateEntry(entry: JournalEntry): void {
  if (!entry.idempotencyKey) throw new InvalidEntryError('idempotencyKey is required');
  if (entry.postings.length < 2) throw new InvalidEntryError('an entry needs at least two postings');

  const sums = new Map<string, bigint>();
  for (const p of entry.postings) {
    if (typeof p.amount !== 'bigint') throw new InvalidEntryError('amounts must be bigint');
    if (p.amount === 0n) throw new InvalidEntryError(`zero posting on ${p.accountId}`);
    if (assetOf(p.accountId) !== p.asset) {
      throw new InvalidEntryError(`posting asset ${p.asset} does not match account ${p.accountId}`);
    }
    sums.set(p.asset, (sums.get(p.asset) ?? 0n) + p.amount);
  }
  for (const [asset, sum] of sums) {
    if (sum !== 0n) throw new InvalidEntryError(`postings for ${asset} sum to ${sum}, expected 0`);
  }
}

/** Net change per account. Sorted by account id so stores lock rows in a stable order. */
export function netDeltas(postings: Posting[]): Array<{ accountId: string; asset: string; delta: bigint }> {
  const byAccount = new Map<string, { accountId: string; asset: string; delta: bigint }>();
  for (const p of postings) {
    const row = byAccount.get(p.accountId) ?? { accountId: p.accountId, asset: p.asset, delta: 0n };
    row.delta += p.amount;
    byAccount.set(p.accountId, row);
  }
  return [...byAccount.values()].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
}

export function assertNoOverdraft(accountId: string, balance: bigint, delta: bigint): void {
  if (balance + delta < 0n && !mayGoNegative(accountId)) {
    throw new InsufficientFundsError(accountId, balance, -delta);
  }
}

/**
 * Canonical form of an entry used to tell an honest retry (same key, same content) from a
 * bug or an attack (same key, different content).
 */
export function fingerprint(entry: JournalEntry): string {
  const legs = netDeltas(entry.postings)
    .filter((d) => d.delta !== 0n)
    .map((d) => `${d.accountId}=${d.delta}`);
  return `${entry.kind}|${legs.join(',')}`;
}
