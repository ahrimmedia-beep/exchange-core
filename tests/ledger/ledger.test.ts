import { beforeEach, describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  InMemoryLedgerStore,
  InsufficientFundsError,
  InvalidEntryError,
  Ledger,
  checkInvariants,
  custodyAccount,
  feesAccount,
  userAccount,
} from '../../src/ledger/index.js';

const ASSETS = { ETH: { decimals: 18 }, USDT: { decimals: 6 } };
const ETH = 10n ** 18n;
const USD = 10n ** 6n;

describe('Ledger', () => {
  let store: InMemoryLedgerStore;
  let ledger: Ledger;

  beforeEach(() => {
    store = new InMemoryLedgerStore();
    ledger = new Ledger(store, ASSETS);
  });

  async function expectInvariants() {
    const report = await checkInvariants(store);
    expect(report.violations).toEqual([]);
  }

  it('credits a deposit against the custody contra account', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 500n * USD, idempotencyKey: 'dep-1' });

    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 500n * USD, locked: 0n });
    expect(await store.getBalance(custodyAccount('USDT'))).toBe(-500n * USD);
    await expectInvariants();
  });

  it('is idempotent: the same key never moves money twice', async () => {
    const first = await ledger.deposit({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'chain:1:0xabc:0' });
    const again = await ledger.deposit({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'chain:1:0xabc:0' });

    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect((await ledger.balanceOf('alice', 'ETH')).available).toBe(ETH);
    expect(store.entryCount).toBe(1);
  });

  it('refuses to reuse a key for a different movement', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'k' });
    await expect(
      ledger.deposit({ userId: 'alice', asset: 'ETH', amount: 2n * ETH, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('locks and unlocks between buckets', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 100n * USD, idempotencyKey: 'd' });
    await ledger.lock({ userId: 'alice', asset: 'USDT', amount: 60n * USD, idempotencyKey: 'l' });
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 40n * USD, locked: 60n * USD });

    await ledger.unlock({ userId: 'alice', asset: 'USDT', amount: 60n * USD, idempotencyKey: 'u' });
    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 100n * USD, locked: 0n });
    await expectInvariants();
  });

  it('rejects an overdraft of available and leaves balances untouched', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 10n * USD, idempotencyKey: 'd' });
    await expect(
      ledger.lock({ userId: 'alice', asset: 'USDT', amount: 10n * USD + 1n, idempotencyKey: 'l' }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await ledger.balanceOf('alice', 'USDT')).toEqual({ available: 10n * USD, locked: 0n });
    expect(store.entryCount).toBe(1);
  });

  it('settles a fill with buyer, seller and fee legs in one entry', async () => {
    await ledger.deposit({ userId: 'bob', asset: 'USDT', amount: 3_000n * USD, idempotencyKey: 'd1' });
    await ledger.deposit({ userId: 'sam', asset: 'ETH', amount: ETH, idempotencyKey: 'd2' });
    await ledger.lock({ userId: 'bob', asset: 'USDT', amount: 2_002n * USD, idempotencyKey: 'l1' });
    await ledger.lock({ userId: 'sam', asset: 'ETH', amount: ETH, idempotencyKey: 'l2' });

    const res = await ledger.settleTrade({
      idempotencyKey: 'trade-1',
      base: 'ETH',
      quote: 'USDT',
      buyerId: 'bob',
      sellerId: 'sam',
      baseQty: ETH,
      quoteQty: 2_000n * USD,
      buyerFee: 2n * USD,
      sellerFee: 1n * USD,
    });

    expect(res.entry.postings).toHaveLength(5);
    expect(await ledger.balanceOf('bob', 'ETH')).toEqual({ available: ETH, locked: 0n });
    expect(await ledger.balanceOf('bob', 'USDT')).toEqual({ available: 998n * USD, locked: 0n });
    expect(await ledger.balanceOf('sam', 'USDT')).toEqual({ available: 1_999n * USD, locked: 0n });
    expect(await ledger.balanceOf('sam', 'ETH')).toEqual({ available: 0n, locked: 0n });
    expect(await store.getBalance(feesAccount('USDT'))).toBe(3n * USD);
    await expectInvariants();
  });

  it('a fill that would overdraw locked funds applies no leg at all', async () => {
    await ledger.deposit({ userId: 'bob', asset: 'USDT', amount: 100n * USD, idempotencyKey: 'd1' });
    await ledger.deposit({ userId: 'sam', asset: 'ETH', amount: ETH, idempotencyKey: 'd2' });
    await ledger.lock({ userId: 'sam', asset: 'ETH', amount: ETH, idempotencyKey: 'l2' });
    // bob never locked any USDT
    await expect(
      ledger.settleTrade({
        idempotencyKey: 't',
        base: 'ETH',
        quote: 'USDT',
        buyerId: 'bob',
        sellerId: 'sam',
        baseQty: ETH,
        quoteQty: 50n * USD,
        buyerFee: 0n,
        sellerFee: 0n,
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.balanceOf('sam', 'ETH')).toEqual({ available: 0n, locked: ETH });
    expect(await ledger.balanceOf('bob', 'ETH')).toEqual({ available: 0n, locked: 0n });
  });

  it('runs the withdrawal lifecycle: request, fail (refund), request, complete', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'ETH', amount: 2n * ETH, idempotencyKey: 'd' });

    await ledger.requestWithdrawal({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'w1:lock' });
    await ledger.failWithdrawal({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'w1:release' });
    expect(await ledger.balanceOf('alice', 'ETH')).toEqual({ available: 2n * ETH, locked: 0n });

    await ledger.requestWithdrawal({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'w2:lock' });
    await ledger.completeWithdrawal({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'w2:done' });
    expect(await ledger.balanceOf('alice', 'ETH')).toEqual({ available: ETH, locked: 0n });
    // custody now mirrors exactly what is left on chain: one ETH
    expect(await store.getBalance(custodyAccount('ETH'))).toBe(-ETH);
    await expectInvariants();
  });

  it('rejects unbalanced entries, unknown assets and non-positive amounts', async () => {
    await expect(
      ledger.post({
        idempotencyKey: 'x',
        kind: 'deposit',
        postings: [
          { accountId: custodyAccount('ETH'), asset: 'ETH', amount: -1n },
          { accountId: userAccount('a', 'ETH', 'available'), asset: 'ETH', amount: 2n },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidEntryError);
    await expect(ledger.deposit({ userId: 'a', asset: 'DOGE', amount: 1n, idempotencyKey: 'y' })).rejects.toThrow(
      /unknown asset/,
    );
    await expect(ledger.deposit({ userId: 'a', asset: 'ETH', amount: 0n, idempotencyKey: 'z' })).rejects.toThrow(
      /positive/,
    );
    await expect(ledger.deposit({ userId: 'a:b', asset: 'ETH', amount: 1n, idempotencyKey: 'w' })).rejects.toThrow(
      /invalid user id/,
    );
  });

  it('lists all balances of a user', async () => {
    await ledger.deposit({ userId: 'alice', asset: 'ETH', amount: ETH, idempotencyKey: 'a' });
    await ledger.deposit({ userId: 'alice', asset: 'USDT', amount: 5n * USD, idempotencyKey: 'b' });
    await ledger.deposit({ userId: 'alice2', asset: 'USDT', amount: 7n * USD, idempotencyKey: 'c' });
    await ledger.lock({ userId: 'alice', asset: 'USDT', amount: 2n * USD, idempotencyKey: 'd' });

    expect(await ledger.balances('alice')).toEqual({
      ETH: { available: ETH, locked: 0n },
      USDT: { available: 3n * USD, locked: 2n * USD },
    });
  });
});
