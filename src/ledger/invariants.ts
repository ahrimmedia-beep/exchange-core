import { mayGoNegative } from './accounts.js';
import type { LedgerStore } from './types.js';

export interface InvariantReport {
  ok: boolean;
  violations: string[];
}

/**
 * Audits a store against the rules that must hold after any sequence of operations:
 *  1. postings of every asset sum to zero (nothing created or destroyed),
 *  2. each materialized balance equals the sum of its postings (no drift in the cache),
 *  3. no user or fee account is negative.
 * Cheap enough to run in tests after every step and, in production, as a periodic job.
 */
export async function checkInvariants(store: LedgerStore): Promise<InvariantReport> {
  const violations: string[] = [];
  const fromPostings = await store.sumPostingsByAccount();
  const balances = await store.listBalances();

  const perAsset = new Map<string, bigint>();
  for (const b of balances) {
    perAsset.set(b.asset, (perAsset.get(b.asset) ?? 0n) + (fromPostings.get(b.accountId) ?? 0n));

    const recomputed = fromPostings.get(b.accountId) ?? 0n;
    if (recomputed !== b.balance) {
      violations.push(`${b.accountId}: balance ${b.balance} != sum of postings ${recomputed}`);
    }
    if (b.balance < 0n && !mayGoNegative(b.accountId)) {
      violations.push(`${b.accountId}: negative balance ${b.balance}`);
    }
  }
  const known = new Set(balances.map((b) => b.accountId));
  for (const accountId of fromPostings.keys()) {
    if (!known.has(accountId)) {
      violations.push(`${accountId}: has postings but no balance row`);
    }
  }
  for (const [asset, sum] of perAsset) {
    if (sum !== 0n) violations.push(`${asset}: postings sum to ${sum}, expected 0`);
  }
  return { ok: violations.length === 0, violations };
}
