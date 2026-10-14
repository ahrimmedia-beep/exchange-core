/** A token transfer into some address, as seen in one block. */
export interface Transfer {
  to: string;
  /** Asset symbol, e.g. 'USDT'. */
  asset: string;
  /** Amount in the token's smallest unit. */
  amount: bigint;
  txHash: string;
  logIndex: number;
}

export interface ChainBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  transfers: Transfer[];
}

/** The minimal view of a chain the deposit watcher needs. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getBlock(n: bigint): Promise<ChainBlock>;
}
