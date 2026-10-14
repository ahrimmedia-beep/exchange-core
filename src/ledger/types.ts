export type EntryKind =
  | 'deposit'
  | 'order_lock'
  | 'order_unlock'
  | 'trade'
  | 'withdrawal_lock'
  | 'withdrawal_release'
  | 'withdrawal_complete';

/** One leg of a journal entry. Positive increases the account balance, negative decreases it. */
export interface Posting {
  accountId: string;
  asset: string;
  amount: bigint;
}

export interface JournalEntry {
  /** Retrying with the same key returns the original entry instead of moving money twice. */
  idempotencyKey: string;
  kind: EntryKind;
  /** Business reference (order id, trade id, tx hash) for audit queries. */
  ref?: string;
  postings: Posting[];
}

export interface PostedEntry extends JournalEntry {
  id: number;
}

export interface PostResult {
  entry: PostedEntry;
  /** True when the idempotency key was already used and nothing moved. */
  duplicate: boolean;
}

export interface AccountBalance {
  accountId: string;
  asset: string;
  balance: bigint;
}

/**
 * Storage port. `post` must be atomic: either the whole entry applies, or nothing does.
 * It is also where the overdraft rule is enforced, because only the store can check
 * balances and write them inside one transaction.
 */
export interface LedgerStore {
  post(entry: JournalEntry): Promise<PostResult>;
  getBalance(accountId: string): Promise<bigint>;
  /** Materialized balances, optionally filtered by account id prefix. */
  listBalances(prefix?: string): Promise<AccountBalance[]>;
  /** Balances recomputed from raw postings, used by the invariant checker. */
  sumPostingsByAccount(): Promise<Map<string, bigint>>;
}

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly balance: bigint,
    readonly requested: bigint,
  ) {
    super('INSUFFICIENT_FUNDS', `insufficient funds in ${accountId}: has ${balance}, needs ${requested}`);
  }
}

export class IdempotencyConflictError extends LedgerError {
  constructor(readonly idempotencyKey: string) {
    super('IDEMPOTENCY_CONFLICT', `idempotency key "${idempotencyKey}" was already used for a different entry`);
  }
}

export class InvalidEntryError extends LedgerError {
  constructor(message: string) {
    super('INVALID_ENTRY', message);
  }
}
