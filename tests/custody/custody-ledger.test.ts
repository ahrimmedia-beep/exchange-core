import { generateMnemonic, english } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { AddressBook, deriveDepositAddress } from '../../src/custody/addresses.js';
import { InMemoryAuditLog } from '../../src/custody/audit-log.js';
import { DepositWatcher, InMemoryCursorStore } from '../../src/custody/deposit-watcher.js';
import { FakeBroadcaster, FakeSigner } from '../../src/custody/signer.js';
import { withdrawalLedger } from '../../src/custody/withdrawal-ledger-adapter.js';
import { WithdrawalService } from '../../src/custody/withdrawals.js';
import { custodyAccount } from '../../src/ledger/accounts.js';
import { InMemoryLedgerStore, InsufficientFundsError, Ledger, checkInvariants } from '../../src/ledger/index.js';
import { FakeChain, transfer } from '../support/fake-chain.js';

const USD = 10n ** 6n;
const EXTERNAL = '0x000000000000000000000000000000000000dEaD';

function wire() {
  const store = new InMemoryLedgerStore();
  const ledger = new Ledger(store, { USDT: { decimals: 6 } });
  return { store, ledger };
}

describe('custody wired to the ledger', () => {
  it('credits an on-chain deposit once, at the confirmation depth, through a reorg', async () => {
    const { store, ledger } = wire();
    const chain = new FakeChain();
    const book = new AddressBook();
    // A throwaway mnemonic generated per run: nothing secret lives in the repo.
    const address = deriveDepositAddress(generateMnemonic(english), 0);
    book.assign(address, 'alice');

    const watcher = new DepositWatcher({
      reader: chain,
      chainId: 1,
      confirmations: 3,
      resolveUser: (a) => book.resolve(a),
      credit: (d) => ledger.deposit(d).then(() => undefined),
      cursor: new InMemoryCursorStore(),
      startBlock: 1n,
    });

    const tx = transfer(address, 250n * USD);
    chain.mine([tx]);
    chain.mineEmpty(1);
    await watcher.poll();
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 0n, locked: 0n });

    chain.mineEmpty(1);
    await watcher.poll();
    expect((await ledger.balanceOf('alice', 'USDT')).available).toBe(250n * USD);

    // The same transaction lands again in a competing fork: the ledger key holds.
    chain.reorg(3, [[tx], [], [], []]);
    await watcher.poll();
    expect((await ledger.balanceOf('alice', 'USDT')).available).toBe(250n * USD);
    expect(await store.getBalance(custodyAccount('USDT'))).toBe(-250n * USD);
    expect((await checkInvariants(store)).violations).toEqual([]);
  });

  it('moves withdrawal funds available -> locked -> out of custody, or back on failure', async () => {
    const { store, ledger } = wire();
    await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 1_000n * USD, idempotencyKey: 'seed' });
    const service = new WithdrawalService({
      ledger: withdrawalLedger(ledger),
      signer: new FakeSigner(),
      broadcaster: new FakeBroadcaster(),
      audit: new InMemoryAuditLog(),
      approvalThreshold: { USDT: 500n * USD },
      dailyLimit: { USDT: 10_000n * USD },
    });

    const ok = await service.request({ userId: 'alice', asset: 'USDT', amount: 300n * USD, to: EXTERNAL, idempotencyKey: 'w1' });
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 700n * USD, locked: 300n * USD });
    await service.process(ok.id);
    await service.confirm(ok.id);
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 700n * USD, locked: 0n });
    // 1000 came in, 300 went out: custody mirrors the 700 still on chain
    expect(await store.getBalance(custodyAccount('USDT'))).toBe(-700n * USD);

    const bad = await service.request({ userId: 'alice', asset: 'USDT', amount: 200n * USD, to: EXTERNAL, idempotencyKey: 'w2' });
    await service.process(bad.id);
    await service.fail(bad.id, 'reverted on chain');
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 700n * USD, locked: 0n });

    await expect(
      service.request({ userId: 'alice', asset: 'USDT', amount: 701n * USD, to: EXTERNAL, idempotencyKey: 'w3' }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect((await checkInvariants(store)).violations).toEqual([]);
  });
});
