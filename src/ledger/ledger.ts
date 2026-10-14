import { custodyAccount, feesAccount, parseUserAccount, userAccount } from './accounts.js';
import { validateEntry } from './entry.js';
import { InvalidEntryError, type JournalEntry, type LedgerStore, type PostResult } from './types.js';

export interface AssetConfig {
  /** Number of decimals of the smallest unit: 18 for ETH, 6 for USDT. */
  decimals: number;
}

export type AssetRegistry = Record<string, AssetConfig>;

export interface UserBalance {
  available: bigint;
  locked: bigint;
}

interface Movement {
  userId: string;
  asset: string;
  amount: bigint;
  idempotencyKey: string;
  ref?: string;
}

export interface TradeSettlement {
  idempotencyKey: string;
  ref?: string;
  base: string;
  quote: string;
  buyerId: string;
  sellerId: string;
  /** Base quantity that changes hands. */
  baseQty: bigint;
  /** Quote notional (price x quantity) before fees. */
  quoteQty: bigint;
  /** Quote fee paid by the buyer on top of the notional, taken from the buyer's locked quote. */
  buyerFee: bigint;
  /** Quote fee deducted from the seller's proceeds. */
  sellerFee: bigint;
}

/**
 * Business operations on top of a LedgerStore. Each method builds exactly one balanced
 * journal entry; the store applies it atomically and enforces idempotency and overdrafts.
 */
export class Ledger {
  constructor(
    private readonly store: LedgerStore,
    private readonly assets: AssetRegistry,
  ) {}

  decimals(asset: string): number {
    const cfg = this.assets[asset];
    if (!cfg) throw new InvalidEntryError(`unknown asset ${asset}`);
    return cfg.decimals;
  }

  hasAsset(asset: string): boolean {
    return asset in this.assets;
  }

  async post(entry: JournalEntry): Promise<PostResult> {
    for (const p of entry.postings) this.decimals(p.asset);
    validateEntry(entry);
    return this.store.post(entry);
  }

  /** A confirmed on-chain deposit: value enters custody and becomes spendable for the user. */
  async deposit(m: Movement): Promise<PostResult> {
    return this.transfer('deposit', m, custodyAccount(m.asset), userAccount(m.userId, m.asset, 'available'));
  }

  /** Reserve funds for an order. Fails with InsufficientFundsError if available is too low. */
  async lock(m: Movement): Promise<PostResult> {
    return this.transfer(
      'order_lock',
      m,
      userAccount(m.userId, m.asset, 'available'),
      userAccount(m.userId, m.asset, 'locked'),
    );
  }

  /** Return reserved funds that an order no longer needs (cancel, expiry, price improvement). */
  async unlock(m: Movement): Promise<PostResult> {
    return this.transfer(
      'order_unlock',
      m,
      userAccount(m.userId, m.asset, 'locked'),
      userAccount(m.userId, m.asset, 'available'),
    );
  }

  /**
   * Settle one fill as a single entry with five legs. Both sides were locked when their
   * orders entered the book, so the debits come from `locked` and the credits land in
   * `available`. Either all legs apply or none do: there is no state where the buyer paid
   * and the seller has not.
   */
  async settleTrade(t: TradeSettlement): Promise<PostResult> {
    if (t.baseQty <= 0n || t.quoteQty <= 0n) throw new InvalidEntryError('trade quantities must be positive');
    if (t.buyerFee < 0n || t.sellerFee < 0n) throw new InvalidEntryError('fees cannot be negative');
    if (t.sellerFee > t.quoteQty) throw new InvalidEntryError('seller fee exceeds proceeds');

    const postings = [
      { accountId: userAccount(t.buyerId, t.quote, 'locked'), asset: t.quote, amount: -(t.quoteQty + t.buyerFee) },
      { accountId: userAccount(t.sellerId, t.quote, 'available'), asset: t.quote, amount: t.quoteQty - t.sellerFee },
      { accountId: userAccount(t.sellerId, t.base, 'locked'), asset: t.base, amount: -t.baseQty },
      { accountId: userAccount(t.buyerId, t.base, 'available'), asset: t.base, amount: t.baseQty },
    ];
    const fee = t.buyerFee + t.sellerFee;
    if (fee > 0n) postings.push({ accountId: feesAccount(t.quote), asset: t.quote, amount: fee });

    return this.post({
      idempotencyKey: t.idempotencyKey,
      kind: 'trade',
      ...(t.ref !== undefined && { ref: t.ref }),
      postings: postings.filter((p) => p.amount !== 0n),
    });
  }

  /** Withdrawal requested: funds leave `available` so they cannot be traded while in flight. */
  async requestWithdrawal(m: Movement): Promise<PostResult> {
    return this.transfer(
      'withdrawal_lock',
      m,
      userAccount(m.userId, m.asset, 'available'),
      userAccount(m.userId, m.asset, 'locked'),
    );
  }

  /** Withdrawal rejected or failed on chain: give the funds back. */
  async failWithdrawal(m: Movement): Promise<PostResult> {
    return this.transfer(
      'withdrawal_release',
      m,
      userAccount(m.userId, m.asset, 'locked'),
      userAccount(m.userId, m.asset, 'available'),
    );
  }

  /** Withdrawal confirmed on chain: the value has left custody for good. */
  async completeWithdrawal(m: Movement): Promise<PostResult> {
    return this.transfer('withdrawal_complete', m, userAccount(m.userId, m.asset, 'locked'), custodyAccount(m.asset));
  }

  async balanceOf(userId: string, asset: string): Promise<UserBalance> {
    const [available, locked] = await Promise.all([
      this.store.getBalance(userAccount(userId, asset, 'available')),
      this.store.getBalance(userAccount(userId, asset, 'locked')),
    ]);
    return { available, locked };
  }

  async balances(userId: string): Promise<Record<string, UserBalance>> {
    const out: Record<string, UserBalance> = {};
    for (const row of await this.store.listBalances(`user:${userId}:`)) {
      const parsed = parseUserAccount(row.accountId);
      if (!parsed || parsed.userId !== userId) continue;
      const b = (out[parsed.asset] ??= { available: 0n, locked: 0n });
      b[parsed.bucket] = row.balance;
    }
    return out;
  }

  private transfer(
    kind: JournalEntry['kind'],
    m: Movement,
    from: string,
    to: string,
  ): Promise<PostResult> {
    if (m.amount <= 0n) throw new InvalidEntryError(`${kind}: amount must be positive`);
    return this.post({
      idempotencyKey: m.idempotencyKey,
      kind,
      ...(m.ref !== undefined && { ref: m.ref }),
      postings: [
        { accountId: from, asset: m.asset, amount: -m.amount },
        { accountId: to, asset: m.asset, amount: m.amount },
      ],
    });
  }
}
