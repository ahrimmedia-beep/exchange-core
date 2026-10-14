import { normalizeAddress } from './addresses.js';
import type { ChainBlock, ChainReader } from './chain-reader.js';

export interface DepositCredit {
  userId: string;
  asset: string;
  amount: bigint;
  idempotencyKey: string;
}

export interface PendingDeposit extends DepositCredit {
  txHash: string;
  logIndex: number;
}

export interface ScannedBlock {
  number: bigint;
  hash: string;
  /** Deposits in this block that have not reached the confirmation depth yet. */
  pending: PendingDeposit[];
}

export interface CreditedDeposit {
  deposit: PendingDeposit;
  blockNumber: bigint;
}

export interface WatcherState {
  /** Contiguous, ascending, newest last. Bounded by the reorg window. */
  blocks: ScannedBlock[];
  /** Deposits credited from blocks that are still inside the reorg window. */
  credited: CreditedDeposit[];
}

export interface CursorStore {
  load(): Promise<WatcherState | undefined>;
  save(state: WatcherState): Promise<void>;
}

export class InMemoryCursorStore implements CursorStore {
  private state: WatcherState | undefined;

  async load(): Promise<WatcherState | undefined> {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }

  async save(state: WatcherState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export interface DepositWatcherOptions {
  reader: ChainReader;
  chainId: number;
  /** A deposit is credited once tip - block + 1 >= confirmations. */
  confirmations: number;
  resolveUser(address: string): string | undefined;
  /** Must be idempotent by `idempotencyKey`: after a crash the same deposit can arrive again. */
  credit(deposit: DepositCredit): void | Promise<void>;
  cursor: CursorStore;
  /** First block to scan on a fresh start. Defaults to the current tip. */
  startBlock?: bigint;
  /** Number of recent block hashes kept for reorg detection. Default 2 * confirmations + 10. */
  reorgWindow?: number;
  /**
   * Called when a reorg removes a block whose deposits were already credited.
   * The funds may no longer exist on chain: this needs a human decision.
   */
  onOrphanedCredit?(deposit: PendingDeposit, blockNumber: bigint): void;
}

export interface PollResult {
  credited: number;
  voided: number;
  reorgs: number;
}

/**
 * Thrown when no block in the stored window matches the canonical chain.
 * The watcher cannot tell which credits are still valid, so it stops until an operator
 * reconciles balances and resets the cursor. Every poll keeps throwing until then.
 */
export class DeepReorgError extends Error {
  constructor(
    readonly oldestKnownBlock: bigint,
    readonly newestKnownBlock: bigint,
  ) {
    super(
      `Reorg deeper than the watcher window (blocks ${oldestKnownBlock}..${newestKnownBlock} all replaced); manual reconciliation required`,
    );
    this.name = 'DeepReorgError';
  }
}

/**
 * Turns ERC-20 transfers to user deposit addresses into ledger credits.
 *
 * Every scanned block is checked against the stored hash of its parent. On a mismatch the
 * watcher walks back to the last block both forks share, voids the pending deposits of the
 * orphaned blocks and rescans the canonical chain from there.
 *
 * A reorg that keeps the chain height is noticed when the next block arrives. That is safe:
 * credits are only issued after a new block has been scanned, and that scan runs the check first.
 */
export class DepositWatcher {
  private readonly window: number;
  private state: WatcherState | undefined;
  private polling = false;

  constructor(private readonly opts: DepositWatcherOptions) {
    if (!Number.isInteger(opts.confirmations) || opts.confirmations < 1) {
      throw new Error('confirmations must be a positive integer');
    }
    this.window = opts.reorgWindow ?? 2 * opts.confirmations + 10;
    if (this.window < opts.confirmations) {
      throw new Error('reorgWindow must be at least the number of confirmations');
    }
  }

  async poll(): Promise<PollResult> {
    if (this.polling) throw new Error('poll() is already running');
    this.polling = true;
    try {
      return await this.scan();
    } finally {
      this.polling = false;
    }
  }

  private async scan(): Promise<PollResult> {
    const state = await this.loadState();
    const result: PollResult = { credited: 0, voided: 0, reorgs: 0 };
    const tip = await this.opts.reader.getBlockNumber();
    if (state.blocks.length === 0) await this.anchor(state, this.opts.startBlock ?? tip, tip);
    let next = this.nextBlock(state, tip);

    while (next <= tip) {
      const block = await this.opts.reader.getBlock(next);
      const parent = state.blocks.at(-1);

      if (parent && block.parentHash !== parent.hash) {
        result.voided += await this.unwindToForkPoint(state);
        result.reorgs += 1;
        await this.opts.cursor.save(state);
        next = this.nextBlock(state, tip);
        continue;
      }

      state.blocks.push({ number: block.number, hash: block.hash, pending: this.matchDeposits(block) });
      result.credited += await this.creditConfirmed(state);
      this.prune(state);
      await this.opts.cursor.save(state);
      next = block.number + 1n;
    }

    return result;
  }

  private nextBlock(state: WatcherState, tip: bigint): bigint {
    const last = state.blocks.at(-1);
    return last ? last.number + 1n : (this.opts.startBlock ?? tip);
  }

  /**
   * Records the block before the start block without scanning it, so a reorg of the very
   * first scanned block still has a known parent to compare against.
   */
  private async anchor(state: WatcherState, start: bigint, tip: bigint): Promise<void> {
    if (start === 0n || start - 1n > tip) return;
    const parent = await this.opts.reader.getBlock(start - 1n);
    state.blocks.push({ number: parent.number, hash: parent.hash, pending: [] });
    await this.opts.cursor.save(state);
  }

  private async loadState(): Promise<WatcherState> {
    this.state ??= (await this.opts.cursor.load()) ?? { blocks: [], credited: [] };
    return this.state;
  }

  private matchDeposits(block: ChainBlock): PendingDeposit[] {
    const deposits: PendingDeposit[] = [];
    for (const t of block.transfers) {
      const userId = this.opts.resolveUser(normalizeAddress(t.to));
      if (userId === undefined) continue;
      deposits.push({
        userId,
        asset: t.asset,
        amount: t.amount,
        txHash: t.txHash,
        logIndex: t.logIndex,
        idempotencyKey: `${this.opts.chainId}:${t.txHash}:${t.logIndex}`,
      });
    }
    return deposits;
  }

  private async creditConfirmed(state: WatcherState): Promise<number> {
    const head = state.blocks.at(-1);
    if (!head) return 0;
    const confirmedUpTo = head.number - BigInt(this.opts.confirmations) + 1n;
    const alreadyCredited = new Set(state.credited.map((c) => c.deposit.idempotencyKey));
    let count = 0;

    for (const block of state.blocks) {
      if (block.number > confirmedUpTo) break;
      while (block.pending.length > 0) {
        const deposit = block.pending[0]!;
        // The same transfer can come back on a new fork after its first block was credited.
        if (!alreadyCredited.has(deposit.idempotencyKey)) {
          const { userId, asset, amount, idempotencyKey } = deposit;
          await this.opts.credit({ userId, asset, amount, idempotencyKey });
          state.credited.push({ deposit, blockNumber: block.number });
          alreadyCredited.add(idempotencyKey);
          count += 1;
        }
        block.pending.shift();
      }
    }
    return count;
  }

  /** Drops orphaned blocks back to the common ancestor. Returns the number of voided deposits. */
  private async unwindToForkPoint(state: WatcherState): Promise<number> {
    let ancestorIndex = -1;
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const stored = state.blocks[i]!;
      const canonical = await this.opts.reader.getBlock(stored.number);
      if (canonical.hash === stored.hash) {
        ancestorIndex = i;
        break;
      }
    }

    if (ancestorIndex === -1) {
      throw new DeepReorgError(state.blocks[0]!.number, state.blocks.at(-1)!.number);
    }

    const orphaned = state.blocks.splice(ancestorIndex + 1);
    const orphanedNumbers = new Set(orphaned.map((b) => b.number));
    for (const c of state.credited) {
      if (orphanedNumbers.has(c.blockNumber)) this.opts.onOrphanedCredit?.(c.deposit, c.blockNumber);
    }
    return orphaned.reduce((sum, b) => sum + b.pending.length, 0);
  }

  private prune(state: WatcherState): void {
    const excess = state.blocks.length - this.window;
    if (excess > 0) state.blocks.splice(0, excess);
    const oldest = state.blocks[0]?.number;
    if (oldest !== undefined) state.credited = state.credited.filter((c) => c.blockNumber >= oldest);
  }
}
