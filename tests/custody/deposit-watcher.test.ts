import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AddressBook } from '../../src/custody/addresses.js';
import {
  DeepReorgError,
  DepositWatcher,
  InMemoryCursorStore,
  type DepositCredit,
  type DepositWatcherOptions,
} from '../../src/custody/deposit-watcher.js';
import { FakeChain, transfer } from '../support/fake-chain.js';

const CHAIN_ID = 1;

function randomAddress(): `0x${string}` {
  return privateKeyToAccount(generatePrivateKey()).address;
}

function setup(overrides: Partial<DepositWatcherOptions> = {}) {
  const chain = new FakeChain();
  const book = new AddressBook();
  const alice = randomAddress();
  book.assign(alice, 'alice');
  const credits: DepositCredit[] = [];
  const cursor = new InMemoryCursorStore();

  const makeWatcher = (extra: Partial<DepositWatcherOptions> = {}) =>
    new DepositWatcher({
      reader: chain,
      chainId: CHAIN_ID,
      confirmations: 3,
      resolveUser: (address) => book.resolve(address),
      credit: (d) => {
        credits.push(d);
      },
      cursor,
      startBlock: 1n,
      ...overrides,
      ...extra,
    });

  return { chain, alice, credits, cursor, makeWatcher, watcher: makeWatcher() };
}

describe('DepositWatcher', () => {
  it('credits a deposit only once it has the required confirmations', async () => {
    const { chain, alice, credits, watcher } = setup({ confirmations: 3 });
    const t = transfer(alice, 250_000_000n);

    chain.mine([t]);
    expect(await watcher.poll()).toEqual({ credited: 0, voided: 0, reorgs: 0 });
    chain.mine();
    expect((await watcher.poll()).credited).toBe(0);
    chain.mine();
    expect((await watcher.poll()).credited).toBe(1);

    expect(credits).toEqual([
      { userId: 'alice', asset: 'USDT', amount: 250_000_000n, idempotencyKey: `${CHAIN_ID}:${t.txHash}:0` },
    ]);

    chain.mineEmpty(5);
    expect((await watcher.poll()).credited).toBe(0);
    expect(credits).toHaveLength(1);
  });

  it('voids a pending deposit when its block is reorged out before confirmation', async () => {
    const { chain, alice, credits, watcher } = setup({ confirmations: 3 });
    chain.mine([transfer(alice, 10n)]);
    chain.mine();
    await watcher.poll();

    chain.reorg(2, [[], [], []]);
    expect(await watcher.poll()).toEqual({ credited: 0, voided: 1, reorgs: 1 });

    chain.mineEmpty(5);
    await watcher.poll();
    expect(credits).toEqual([]);
  });

  it('credits a deposit re-included on the new fork exactly once, after it confirms there', async () => {
    const { chain, alice, credits, watcher } = setup({ confirmations: 3 });
    const t = transfer(alice, 10n);
    chain.mine([t]);
    chain.mine();
    await watcher.poll();

    chain.reorg(2, [[], [t], []]);
    expect(await watcher.poll()).toEqual({ credited: 0, voided: 1, reorgs: 1 });

    chain.mine();
    expect((await watcher.poll()).credited).toBe(1);
    chain.mineEmpty(5);
    await watcher.poll();

    expect(credits.map((c) => c.idempotencyKey)).toEqual([`${CHAIN_ID}:${t.txHash}:0`]);
  });

  it('never credits twice when a reorg hits a block that was already credited', async () => {
    const orphaned: string[] = [];
    const { chain, alice, credits, watcher } = setup({
      confirmations: 2,
      onOrphanedCredit: (d) => orphaned.push(d.idempotencyKey),
    });
    const t = transfer(alice, 10n);
    chain.mine([t]);
    chain.mine();
    expect((await watcher.poll()).credited).toBe(1);

    chain.reorg(2, [[t], [], []]);
    expect(await watcher.poll()).toEqual({ credited: 0, voided: 0, reorgs: 1 });

    expect(credits).toHaveLength(1);
    expect(orphaned).toEqual([`${CHAIN_ID}:${t.txHash}:0`]);
  });

  it('notices a same-height reorg once the next block arrives, before crediting anything', async () => {
    const { chain, alice, credits, watcher } = setup({ confirmations: 2 });
    chain.mine([transfer(alice, 10n)]);
    await watcher.poll();

    chain.reorg(1, [[]]);
    expect(await watcher.poll()).toEqual({ credited: 0, voided: 0, reorgs: 0 });

    chain.mine();
    expect(await watcher.poll()).toEqual({ credited: 0, voided: 1, reorgs: 1 });
    expect(credits).toEqual([]);
  });

  it('resumes from the saved cursor after a restart without crediting again', async () => {
    const { chain, alice, credits, makeWatcher } = setup({ confirmations: 2 });
    const first = makeWatcher();
    const t1 = transfer(alice, 1n);
    const t2 = transfer(alice, 2n);

    chain.mine([t1]);
    chain.mine();
    expect((await first.poll()).credited).toBe(1);
    chain.mine([t2]);
    expect((await first.poll()).credited).toBe(0);

    const restarted = makeWatcher();
    chain.mineEmpty(3);
    expect((await restarted.poll()).credited).toBe(1);

    expect(credits.map((c) => c.amount)).toEqual([1n, 2n]);
  });

  it('detects a reorg that happened while it was down', async () => {
    const { chain, alice, credits, makeWatcher } = setup({ confirmations: 3 });
    chain.mine([transfer(alice, 1n)]);
    await makeWatcher().poll();

    chain.reorg(1, [[], [], []]);
    expect(await makeWatcher().poll()).toEqual({ credited: 0, voided: 1, reorgs: 1 });
    expect(credits).toEqual([]);
  });

  it('ignores transfers to addresses that belong to no user', async () => {
    const { chain, credits, watcher } = setup({ confirmations: 1 });
    chain.mine([transfer(randomAddress(), 5n)]);
    chain.mineEmpty(3);
    await watcher.poll();
    expect(credits).toEqual([]);
  });

  it('matches deposit addresses regardless of letter case', async () => {
    const { chain, alice, credits, watcher } = setup({ confirmations: 1 });
    const upper = `0x${alice.slice(2).toUpperCase()}`;
    chain.mine([transfer(alice.toLowerCase(), 1n, { logIndex: 0 }), transfer(upper, 2n, { logIndex: 1 })]);
    await watcher.poll();

    expect(credits.map((c) => [c.userId, c.amount])).toEqual([
      ['alice', 1n],
      ['alice', 2n],
    ]);
  });

  it('stops with a clear error when a reorg goes deeper than its window', async () => {
    const { chain, alice, watcher } = setup({ confirmations: 1, reorgWindow: 3 });
    chain.mine([transfer(alice, 1n)]);
    chain.mineEmpty(4);
    await watcher.poll();

    chain.reorg(5, [[], [], [], [], [], []]);
    await expect(watcher.poll()).rejects.toBeInstanceOf(DeepReorgError);
    await expect(watcher.poll()).rejects.toThrow(/manual reconciliation/);
  });
});
