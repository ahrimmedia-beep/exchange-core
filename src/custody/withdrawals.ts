import { randomUUID } from 'node:crypto';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import type { AuditLog } from './audit-log.js';
import type { Broadcaster, SignedTx, Signer } from './signer.js';

export type { Broadcaster, Signer } from './signer.js';

/**
 * Port to the balance ledger. Every call carries an idempotency key so a retry
 * after a crash or timeout cannot move the same funds twice.
 */
export interface WithdrawalLedger {
  /** available -> locked */
  lock(userId: string, asset: string, amount: bigint, key: string): void | Promise<void>;
  /** locked -> available (refund) */
  release(userId: string, asset: string, amount: bigint, key: string): void | Promise<void>;
  /** locked -> leaves custody */
  settle(userId: string, asset: string, amount: bigint, key: string): void | Promise<void>;
}

export type WithdrawalStatus =
  | 'pending_approval'
  | 'approved'
  | 'signed'
  | 'broadcast'
  | 'confirmed'
  | 'rejected'
  | 'failed';

export interface Withdrawal {
  readonly id: string;
  readonly userId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly to: Address;
  readonly status: WithdrawalStatus;
  readonly createdAt: Date;
  readonly txHash?: Hex;
  readonly reason?: string;
}

export type WithdrawalErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_ADDRESS'
  | 'UNSUPPORTED_ASSET'
  | 'USER_FROZEN'
  | 'DAILY_LIMIT_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SELF_APPROVAL'
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'IN_PROGRESS';

export class WithdrawalError extends Error {
  readonly code: WithdrawalErrorCode;

  constructor(code: WithdrawalErrorCode, message: string) {
    super(message);
    this.name = 'WithdrawalError';
    this.code = code;
  }
}

export interface WithdrawalRequest {
  readonly userId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly to: string;
  readonly idempotencyKey: string;
}

export interface WithdrawalServiceOptions {
  readonly ledger: WithdrawalLedger;
  readonly signer: Signer;
  readonly broadcaster: Broadcaster;
  readonly audit: AuditLog;
  /** Per asset: amounts at or above this need a manual approval. */
  readonly approvalThreshold: Readonly<Record<string, bigint>>;
  /** Per asset: maximum a user can withdraw within any rolling 24 hours. */
  readonly dailyLimit: Readonly<Record<string, bigint>>;
  readonly now?: () => Date;
  readonly idGen?: () => string;
}

const TRANSITIONS: Readonly<Record<WithdrawalStatus, readonly WithdrawalStatus[]>> = {
  pending_approval: ['approved', 'rejected'],
  approved: ['signed', 'rejected', 'failed'],
  signed: ['broadcast', 'failed'],
  broadcast: ['confirmed', 'failed'],
  confirmed: [],
  rejected: [],
  failed: [],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM = 'system';

interface WithdrawalRecord {
  id: string;
  userId: string;
  asset: string;
  amount: bigint;
  to: Address;
  status: WithdrawalStatus;
  createdAt: Date;
  txHash?: Hex;
  rawTx?: Hex;
  reason?: string;
}

export class WithdrawalService {
  readonly #ledger: WithdrawalLedger;
  readonly #signer: Signer;
  readonly #broadcaster: Broadcaster;
  readonly #audit: AuditLog;
  readonly #approvalThreshold: Readonly<Record<string, bigint>>;
  readonly #dailyLimit: Readonly<Record<string, bigint>>;
  readonly #now: () => Date;
  readonly #idGen: () => string;

  readonly #withdrawals = new Map<string, WithdrawalRecord>();
  readonly #byIdempotencyKey = new Map<string, { input: WithdrawalRequest; result: Promise<Withdrawal> }>();
  readonly #frozenUsers = new Set<string>();
  readonly #busy = new Set<string>();

  constructor(options: WithdrawalServiceOptions) {
    this.#ledger = options.ledger;
    this.#signer = options.signer;
    this.#broadcaster = options.broadcaster;
    this.#audit = options.audit;
    this.#approvalThreshold = options.approvalThreshold;
    this.#dailyLimit = options.dailyLimit;
    this.#now = options.now ?? (() => new Date());
    this.#idGen = options.idGen ?? randomUUID;
  }

  get(id: string): Withdrawal {
    return snapshot(this.#find(id));
  }

  isFrozen(userId: string): boolean {
    return this.#frozenUsers.has(userId);
  }

  request(input: WithdrawalRequest): Promise<Withdrawal> {
    const scopedKey = `${input.userId}:${input.idempotencyKey}`;
    const previous = this.#byIdempotencyKey.get(scopedKey);
    if (previous) {
      if (!sameRequest(previous.input, input)) {
        return Promise.reject(
          new WithdrawalError('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different parameters'),
        );
      }
      return previous.result;
    }

    // Registered before the first await so a concurrent retry with the same
    // key joins this attempt instead of locking funds a second time.
    const result = this.#createWithdrawal(input);
    this.#byIdempotencyKey.set(scopedKey, { input, result });
    result.catch(() => this.#byIdempotencyKey.delete(scopedKey));
    return result;
  }

  approve(id: string, adminId: string): Withdrawal {
    const record = this.#find(id);
    this.#assertIdle(record);
    if (record.userId === adminId) {
      throw new WithdrawalError('SELF_APPROVAL', 'a user cannot approve their own withdrawal');
    }
    this.#assertNotFrozen(record.userId);
    this.#transition(record, 'approved', adminId);
    return snapshot(record);
  }

  reject(id: string, adminId: string, reason: string): Promise<Withdrawal> {
    return this.#exclusive(id, async (record) => {
      this.#assertTransition(record, 'rejected');
      await this.#ledger.release(record.userId, record.asset, record.amount, `wd:${record.id}:release`);
      record.reason = reason;
      this.#transition(record, 'rejected', adminId, { reason });
      return snapshot(record);
    });
  }

  freeze(userId: string, adminId: string): void {
    if (this.#frozenUsers.has(userId)) return;
    this.#frozenUsers.add(userId);
    this.#audit.append({ at: this.#now(), actor: adminId, action: 'user.frozen', userId });
  }

  unfreeze(userId: string, adminId: string): void {
    if (!this.#frozenUsers.has(userId)) return;
    this.#frozenUsers.delete(userId);
    this.#audit.append({ at: this.#now(), actor: adminId, action: 'user.unfrozen', userId });
  }

  /**
   * Signs and broadcasts an approved withdrawal. Called again on a `signed`
   * withdrawal it retries only the broadcast, reusing the same signed tx.
   */
  process(id: string): Promise<Withdrawal> {
    return this.#exclusive(id, async (record) => {
      if (record.status !== 'signed') {
        this.#assertTransition(record, 'signed');
        this.#assertNotFrozen(record.userId);
        const signed = await this.#sign(record);
        if (!signed) return snapshot(record);
      }
      await this.#broadcast(record);
      return snapshot(record);
    });
  }

  confirm(id: string): Promise<Withdrawal> {
    return this.#exclusive(id, async (record) => {
      this.#assertTransition(record, 'confirmed');
      await this.#ledger.settle(record.userId, record.asset, record.amount, `wd:${record.id}:settle`);
      this.#transition(record, 'confirmed', SYSTEM, { txHash: record.txHash });
      return snapshot(record);
    });
  }

  fail(id: string, reason: string): Promise<Withdrawal> {
    return this.#exclusive(id, (record) => this.#failAndRefund(record, reason));
  }

  async #createWithdrawal(input: WithdrawalRequest): Promise<Withdrawal> {
    const { userId, asset, amount, idempotencyKey } = input;
    let to: Address;
    try {
      to = this.#validate(input);
    } catch (error) {
      if (error instanceof WithdrawalError) {
        this.#audit.append({
          at: this.#now(),
          actor: userId,
          action: 'withdrawal.denied',
          userId,
          details: { code: error.code, asset, amount: amount.toString() },
        });
      }
      throw error;
    }

    const id = this.#idGen();
    const record: WithdrawalRecord = {
      id,
      userId,
      asset,
      amount,
      to,
      status: 'pending_approval',
      createdAt: this.#now(),
    };
    // Stored before the ledger call so that a concurrent request from the same
    // user already counts this amount against the daily limit.
    this.#withdrawals.set(id, record);
    try {
      await this.#ledger.lock(userId, asset, amount, `wd:${id}:lock`);
    } catch (error) {
      this.#withdrawals.delete(id);
      throw error;
    }

    this.#audit.append({
      at: record.createdAt,
      actor: userId,
      action: 'withdrawal.requested',
      withdrawalId: id,
      userId,
      details: { asset, amount: amount.toString(), to, idempotencyKey },
    });

    // An asset without a configured threshold fails closed: every amount needs approval.
    const threshold = this.#approvalThreshold[asset] ?? 0n;
    if (amount < threshold) {
      this.#transition(record, 'approved', SYSTEM, { auto: true });
    } else {
      this.#audit.append({
        at: this.#now(),
        actor: SYSTEM,
        action: 'withdrawal.pending_approval',
        withdrawalId: id,
        userId,
        details: { threshold: threshold.toString() },
      });
    }
    return snapshot(record);
  }

  #validate(input: WithdrawalRequest): Address {
    const { userId, asset, amount, to } = input;
    if (typeof amount !== 'bigint' || amount <= 0n) {
      throw new WithdrawalError('INVALID_AMOUNT', 'amount must be a positive bigint');
    }
    // Strict mode rejects a mixed-case address whose checksum does not match,
    // which is how a mistyped character usually shows up.
    if (!isAddress(to, { strict: true })) {
      throw new WithdrawalError('INVALID_ADDRESS', `not a valid address: ${to}`);
    }
    const limit = this.#dailyLimit[asset];
    if (limit === undefined) {
      throw new WithdrawalError('UNSUPPORTED_ASSET', `withdrawals of ${asset} are not enabled`);
    }
    this.#assertNotFrozen(userId);

    const used = this.#withdrawnInLastDay(userId, asset);
    if (used + amount > limit) {
      throw new WithdrawalError(
        'DAILY_LIMIT_EXCEEDED',
        `24h limit for ${asset} is ${limit}, already used ${used}, requested ${amount}`,
      );
    }
    return getAddress(to);
  }

  #withdrawnInLastDay(userId: string, asset: string): bigint {
    const since = this.#now().getTime() - DAY_MS;
    let total = 0n;
    for (const w of this.#withdrawals.values()) {
      if (w.userId !== userId || w.asset !== asset) continue;
      if (w.status === 'rejected' || w.status === 'failed') continue;
      if (w.createdAt.getTime() <= since) continue;
      total += w.amount;
    }
    return total;
  }

  async #sign(record: WithdrawalRecord): Promise<boolean> {
    let tx: SignedTx;
    try {
      tx = await this.#signer.sign({
        withdrawalId: record.id,
        asset: record.asset,
        amount: record.amount,
        to: record.to,
      });
    } catch (error) {
      // Nothing was signed, so nothing can reach the chain: refunding is safe.
      await this.#failAndRefund(record, `signing failed: ${errorMessage(error)}`);
      return false;
    }
    record.rawTx = tx.rawTx;
    record.txHash = tx.txHash;
    this.#transition(record, 'signed', SYSTEM, { txHash: tx.txHash });
    return true;
  }

  async #broadcast(record: WithdrawalRecord): Promise<void> {
    const { rawTx, txHash } = record;
    if (rawTx === undefined || txHash === undefined) {
      throw new WithdrawalError('ILLEGAL_TRANSITION', `withdrawal ${record.id} has no signed transaction`);
    }
    try {
      await this.#broadcaster.broadcast({ withdrawalId: record.id, asset: record.asset, rawTx, txHash });
    } catch (error) {
      // The signed tx may still have reached a node, so the funds stay locked
      // and the withdrawal stays `signed` until a retry or an explicit fail().
      this.#audit.append({
        at: this.#now(),
        actor: SYSTEM,
        action: 'withdrawal.broadcast_failed',
        withdrawalId: record.id,
        userId: record.userId,
        details: { txHash, error: errorMessage(error) },
      });
      throw error;
    }
    this.#transition(record, 'broadcast', SYSTEM, { txHash });
  }

  async #failAndRefund(record: WithdrawalRecord, reason: string): Promise<Withdrawal> {
    this.#assertTransition(record, 'failed');
    await this.#ledger.release(record.userId, record.asset, record.amount, `wd:${record.id}:release`);
    record.reason = reason;
    this.#transition(record, 'failed', SYSTEM, { reason });
    return snapshot(record);
  }

  /** Runs one operation at a time per withdrawal, so funds cannot be released or settled twice. */
  async #exclusive<T>(id: string, operation: (record: WithdrawalRecord) => Promise<T>): Promise<T> {
    const record = this.#find(id);
    this.#assertIdle(record);
    this.#busy.add(id);
    try {
      return await operation(record);
    } finally {
      this.#busy.delete(id);
    }
  }

  #find(id: string): WithdrawalRecord {
    const record = this.#withdrawals.get(id);
    if (!record) throw new WithdrawalError('NOT_FOUND', `withdrawal ${id} not found`);
    return record;
  }

  #assertIdle(record: WithdrawalRecord): void {
    if (this.#busy.has(record.id)) {
      throw new WithdrawalError('IN_PROGRESS', `withdrawal ${record.id} is being processed`);
    }
  }

  #assertNotFrozen(userId: string): void {
    if (this.#frozenUsers.has(userId)) {
      throw new WithdrawalError('USER_FROZEN', `user ${userId} is frozen`);
    }
  }

  #assertTransition(record: WithdrawalRecord, next: WithdrawalStatus): void {
    if (!TRANSITIONS[record.status].includes(next)) {
      throw new WithdrawalError(
        'ILLEGAL_TRANSITION',
        `withdrawal ${record.id} cannot go from ${record.status} to ${next}`,
      );
    }
  }

  #transition(
    record: WithdrawalRecord,
    next: WithdrawalStatus,
    actor: string,
    details?: Record<string, unknown>,
  ): void {
    this.#assertTransition(record, next);
    const from = record.status;
    record.status = next;
    this.#audit.append({
      at: this.#now(),
      actor,
      action: `withdrawal.${next}`,
      withdrawalId: record.id,
      userId: record.userId,
      details: { from, ...details },
    });
  }
}

function snapshot(record: WithdrawalRecord): Withdrawal {
  return Object.freeze({
    id: record.id,
    userId: record.userId,
    asset: record.asset,
    amount: record.amount,
    to: record.to,
    status: record.status,
    createdAt: new Date(record.createdAt.getTime()),
    ...(record.txHash !== undefined && { txHash: record.txHash }),
    ...(record.reason !== undefined && { reason: record.reason }),
  });
}

function sameRequest(a: WithdrawalRequest, b: WithdrawalRequest): boolean {
  return a.asset === b.asset && a.amount === b.amount && a.to.toLowerCase() === b.to.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
