import type { ChainBlock, ChainReader, Transfer } from '../../src/custody/chain-reader.js';

let txCounter = 0;

function fakeHash(prefix: string, n: number): string {
  return `0x${prefix}${n.toString(16).padStart(63, '0')}`;
}

/** A transfer with a unique tx hash unless one is given. */
export function transfer(
  to: string,
  amount: bigint,
  opts: { asset?: string; txHash?: string; logIndex?: number } = {},
): Transfer {
  return {
    to,
    amount,
    asset: opts.asset ?? 'USDT',
    txHash: opts.txHash ?? fakeHash('a', ++txCounter),
    logIndex: opts.logIndex ?? 0,
  };
}

/** In-memory chain starting at a genesis block 0. Blocks on every fork get fresh hashes. */
export class FakeChain implements ChainReader {
  private readonly blocks: ChainBlock[] = [];
  private hashCounter = 0;

  constructor() {
    this.blocks.push({ number: 0n, hash: this.nextHash(), parentHash: fakeHash('0', 0), transfers: [] });
  }

  get tip(): bigint {
    return this.head().number;
  }

  /** Mines one block with the given transfers. */
  mine(transfers: Transfer[] = []): ChainBlock {
    const parent = this.head();
    const block: ChainBlock = {
      number: parent.number + 1n,
      hash: this.nextHash(),
      parentHash: parent.hash,
      transfers,
    };
    this.blocks.push(block);
    return block;
  }

  mineEmpty(count: number): void {
    for (let i = 0; i < count; i++) this.mine();
  }

  /** Replaces the last `depth` blocks with a fork made of `newBlocks` (one transfer list per block). */
  reorg(depth: number, newBlocks: Transfer[][]): void {
    if (depth < 1 || depth >= this.blocks.length) throw new Error(`Cannot reorg ${depth} blocks`);
    this.blocks.splice(this.blocks.length - depth);
    for (const transfers of newBlocks) this.mine(transfers);
  }

  async getBlockNumber(): Promise<bigint> {
    return this.tip;
  }

  async getBlock(n: bigint): Promise<ChainBlock> {
    const block = this.blocks[Number(n)];
    if (!block) throw new Error(`Block ${n} not found`);
    return structuredClone(block);
  }

  private head(): ChainBlock {
    return this.blocks[this.blocks.length - 1]!;
  }

  private nextHash(): string {
    return fakeHash('b', ++this.hashCounter);
  }
}
