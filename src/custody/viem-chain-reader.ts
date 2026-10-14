import { getAddress, parseAbiItem, type Address, type PublicClient } from 'viem';
import type { ChainBlock, ChainReader, Transfer } from './chain-reader.js';

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * Reads ERC-20 deposits from an EVM node.
 * Native coin transfers are not covered: they need trace or full-transaction scanning.
 */
export class ViemChainReader implements ChainReader {
  private readonly tokens = new Map<Address, string>();

  /** @param tokens ERC-20 contract address -> asset symbol */
  constructor(
    private readonly client: PublicClient,
    tokens: Record<string, string>,
  ) {
    for (const [address, symbol] of Object.entries(tokens)) {
      this.tokens.set(getAddress(address), symbol);
    }
  }

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async getBlock(n: bigint): Promise<ChainBlock> {
    const block = await this.client.getBlock({ blockNumber: n });
    const transfers: Transfer[] = [];

    if (this.tokens.size > 0) {
      // Query by block hash, not number, so the logs belong to exactly this header
      // even if the node switches forks between the two calls.
      const logs = await this.client.getLogs({
        address: [...this.tokens.keys()],
        event: transferEvent,
        blockHash: block.hash,
      });
      for (const log of logs) {
        const asset = this.tokens.get(getAddress(log.address));
        const { to, value } = log.args;
        if (!asset || !to || value === undefined) continue;
        if (log.transactionHash === null || log.logIndex === null) continue;
        transfers.push({
          to,
          asset,
          amount: value,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        });
      }
    }

    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      transfers,
    };
  }
}
