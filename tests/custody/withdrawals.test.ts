import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '../../src/custody/audit-log.js';
import { FakeBroadcaster, FakeSigner } from '../../src/custody/signer.js';
import {
  WithdrawalError,
  WithdrawalService,
  type WithdrawalErrorCode,
  type WithdrawalLedger,
  type WithdrawalRequest,
} from '../../src/custody/withdrawals.js';

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ETH = 10n ** 18n;

interface LedgerCall {
  op: 'lock' | 'release' | 'settle';
  userId: string;
  asset: string;
  amount: bigint;
  key: string;
}

class RecordingLedger implements WithdrawalLedger {
  readonly calls: LedgerCall[] = [];

  async lock(userId: string, asset: string, amount: bigint, key: string): Promise<void> {
    this.calls.push({ op: 'lock', userId, asset, amount, key });
  }

  async release(userId: string, asset: string, amount: bigint, key: string): Promise<void> {
    this.calls.push({ op: 'release', userId, asset, amount, key });
  }

  async settle(userId: string, asset: string, amount: bigint, key: string): Promise<void> {
    this.calls.push({ op: 'settle', userId, asset, amount, key });
  }

  ops(): string[] {
    return this.calls.map((c) => `${c.op} ${c.key}`);
  }
}

async function expectCode(action: Promise<unknown> | (() => unknown), code: WithdrawalErrorCode) {
  const promise = typeof action === 'function' ? Promise.resolve().then(action) : action;
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WithdrawalError);
  expect((error as WithdrawalError).code).toBe(code);
}

describe('WithdrawalService', () => {
  let ledger: RecordingLedger;
  let signer: FakeSigner;
  let broadcaster: FakeBroadcaster;
  let audit: InMemoryAuditLog;
  let clock: Date;
  let service: WithdrawalService;

  beforeEach(() => {
    ledger = new RecordingLedger();
    signer = new FakeSigner();
    broadcaster = new FakeBroadcaster();
    audit = new InMemoryAuditLog();
    clock = new Date('2026-01-01T12:00:00Z');
    let seq = 0;
    service = new WithdrawalService({
      ledger,
      signer,
      broadcaster,
      audit,
      approvalThreshold: { ETH: 10n * ETH },
      dailyLimit: { ETH: 25n * ETH },
      now: () => new Date(clock.getTime()),
      idGen: () => `w${++seq}`,
    });
  });

  function request(overrides: Partial<WithdrawalRequest> = {}) {
    return service.request({
      userId: 'alice',
      asset: 'ETH',
      amount: 1n * ETH,
      to: ADDRESS,
      idempotencyKey: `k-${Math.random()}`,
      ...overrides,
    });
  }

  it('auto-approves a small withdrawal and takes it through to confirmed', async () => {
    const created = await request();
    expect(created.status).toBe('approved');

    const sent = await service.process(created.id);
    expect(sent.status).toBe('broadcast');
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(broadcaster.sent).toHaveLength(1);
    expect(broadcaster.sent[0]?.txHash).toBe(sent.txHash);

    const done = await service.confirm(created.id);
    expect(done.status).toBe('confirmed');
    expect(ledger.calls).toEqual([
      { op: 'lock', userId: 'alice', asset: 'ETH', amount: ETH, key: 'wd:w1:lock' },
      { op: 'settle', userId: 'alice', asset: 'ETH', amount: ETH, key: 'wd:w1:settle' },
    ]);
  });

  it('holds an amount at the threshold for manual approval', async () => {
    const created = await request({ amount: 10n * ETH });
    expect(created.status).toBe('pending_approval');
    await expectCode(service.process(created.id), 'ILLEGAL_TRANSITION');
    expect(signer.requests).toHaveLength(0);

    expect(service.approve(created.id, 'admin-1').status).toBe('approved');
    await service.process(created.id);
    expect((await service.confirm(created.id)).status).toBe('confirmed');
    expect(ledger.ops()).toEqual(['lock wd:w1:lock', 'settle wd:w1:settle']);
  });

  it('does not let a user approve their own withdrawal', async () => {
    const created = await request({ amount: 10n * ETH });
    await expectCode(() => service.approve(created.id, 'alice'), 'SELF_APPROVAL');
    expect(service.get(created.id).status).toBe('pending_approval');
  });

  it('releases the funds when an admin rejects', async () => {
    const created = await request({ amount: 12n * ETH });
    const rejected = await service.reject(created.id, 'admin-1', 'suspicious destination');

    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('suspicious destination');
    expect(ledger.ops()).toEqual(['lock wd:w1:lock', 'release wd:w1:release']);
  });

  it('marks the withdrawal failed and refunds when signing fails', async () => {
    signer.failWith(new Error('hsm offline'));
    const created = await request();

    const result = await service.process(created.id);

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('hsm offline');
    expect(broadcaster.sent).toHaveLength(0);
    expect(ledger.ops()).toEqual(['lock wd:w1:lock', 'release wd:w1:release']);
  });

  it('keeps funds locked when broadcast fails and retries with the same signed tx', async () => {
    broadcaster.failWith();
    const created = await request();

    await expect(service.process(created.id)).rejects.toThrow('node unreachable');
    expect(service.get(created.id).status).toBe('signed');
    expect(ledger.ops()).toEqual(['lock wd:w1:lock']);

    broadcaster.recover();
    const retried = await service.process(created.id);
    expect(retried.status).toBe('broadcast');
    expect(signer.requests).toHaveLength(1);
  });

  it('rejects a request over the rolling 24h limit without touching the ledger', async () => {
    await request({ amount: 9n * ETH });
    await request({ amount: 9n * ETH });
    const callsBefore = ledger.calls.length;

    await expectCode(request({ amount: 8n * ETH }), 'DAILY_LIMIT_EXCEEDED');
    expect(ledger.calls).toHaveLength(callsBefore);

    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    expect((await request({ amount: 8n * ETH })).status).toBe('approved');
  });

  it('does not count rejected or failed withdrawals against the limit', async () => {
    const big = await request({ amount: 20n * ETH });
    await service.reject(big.id, 'admin-1', 'kyc');
    signer.failWith();
    const small = await request({ amount: 5n * ETH });
    await service.process(small.id);

    expect((await request({ amount: 25n * ETH })).status).toBe('pending_approval');
  });

  it('counts concurrent requests against the limit', async () => {
    const results = await Promise.allSettled([
      request({ amount: 9n * ETH }),
      request({ amount: 9n * ETH }),
      request({ amount: 9n * ETH }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(ledger.calls.filter((c) => c.op === 'lock')).toHaveLength(2);
  });

  it('refuses requests from a frozen user until unfrozen', async () => {
    service.freeze('alice', 'admin-1');
    await expectCode(request(), 'USER_FROZEN');
    expect(ledger.calls).toHaveLength(0);

    service.unfreeze('alice', 'admin-1');
    expect((await request()).status).toBe('approved');
  });

  it('stops processing for a user frozen after approval', async () => {
    const created = await request();
    service.freeze('alice', 'admin-1');
    await expectCode(service.process(created.id), 'USER_FROZEN');
    expect(signer.requests).toHaveLength(0);
  });

  it('rejects malformed destinations and bad checksums', async () => {
    await expectCode(request({ to: 'not-an-address' }), 'INVALID_ADDRESS');
    await expectCode(request({ to: '0x1234' }), 'INVALID_ADDRESS');
    // Last character's case flipped: still hex, but the checksum no longer matches.
    await expectCode(request({ to: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' }), 'INVALID_ADDRESS');
    expect(ledger.calls).toHaveLength(0);
  });

  it('normalises a lowercase destination to its checksummed form', async () => {
    const created = await request({ to: ADDRESS.toLowerCase() });
    expect(created.to).toBe(ADDRESS);
  });

  it('rejects non-positive amounts and unknown assets', async () => {
    await expectCode(request({ amount: 0n }), 'INVALID_AMOUNT');
    await expectCode(request({ amount: -1n }), 'INVALID_AMOUNT');
    await expectCode(request({ asset: 'DOGE' }), 'UNSUPPORTED_ASSET');
    expect(ledger.calls).toHaveLength(0);
  });

  it('returns the same withdrawal for a repeated idempotency key and locks once', async () => {
    const first = await request({ idempotencyKey: 'abc' });
    const again = await request({ idempotencyKey: 'abc' });
    const [x, y] = await Promise.all([request({ idempotencyKey: 'xyz' }), request({ idempotencyKey: 'xyz' })]);

    expect(again.id).toBe(first.id);
    expect(x.id).toBe(y.id);
    expect(ledger.calls.filter((c) => c.op === 'lock')).toHaveLength(2);
  });

  it('refuses an idempotency key reused with different parameters', async () => {
    await request({ idempotencyKey: 'abc' });
    await expectCode(request({ idempotencyKey: 'abc', amount: 2n * ETH }), 'IDEMPOTENCY_CONFLICT');
  });

  it('lets the key be retried after the ledger refused the lock', async () => {
    let refuse = true;
    const lock = ledger.lock.bind(ledger);
    ledger.lock = async (...args) => {
      if (refuse) throw new Error('insufficient balance');
      return lock(...args);
    };

    await expect(request({ idempotencyKey: 'retry' })).rejects.toThrow('insufficient balance');
    refuse = false;
    expect((await request({ idempotencyKey: 'retry' })).status).toBe('approved');
  });

  it('throws a typed error on every illegal transition', async () => {
    const created = await request();
    await expectCode(service.confirm(created.id), 'ILLEGAL_TRANSITION');
    await expectCode(() => service.approve(created.id, 'admin-1'), 'ILLEGAL_TRANSITION');

    await service.process(created.id);
    await expectCode(service.process(created.id), 'ILLEGAL_TRANSITION');
    await expectCode(service.reject(created.id, 'admin-1', 'late'), 'ILLEGAL_TRANSITION');

    await service.confirm(created.id);
    await expectCode(service.confirm(created.id), 'ILLEGAL_TRANSITION');
    await expectCode(service.fail(created.id, 'late'), 'ILLEGAL_TRANSITION');
    await expectCode(() => service.get('missing'), 'NOT_FOUND');

    expect(ledger.ops()).toEqual(['lock wd:w1:lock', 'settle wd:w1:settle']);
  });

  it('refunds a broadcast withdrawal that is failed by an operator', async () => {
    const created = await request();
    await service.process(created.id);
    const failed = await service.fail(created.id, 'dropped from mempool');

    expect(failed.status).toBe('failed');
    expect(ledger.ops()).toEqual(['lock wd:w1:lock', 'release wd:w1:release']);
  });

  it('refuses a second operation while one is still running', async () => {
    const created = await request();
    // Started in the same tick, so the first call is still waiting on the signer.
    const first = service.process(created.id);
    const second = service.process(created.id);
    const third = service.fail(created.id, 'race');

    await expectCode(second, 'IN_PROGRESS');
    await expectCode(third, 'IN_PROGRESS');
    expect((await first).status).toBe('broadcast');
    expect(signer.requests).toHaveLength(1);
  });

  it('returns snapshots that cannot change service state', async () => {
    const created = await request();
    expect(Object.isFrozen(created)).toBe(true);
    created.createdAt.setFullYear(2000);
    expect(service.get(created.id).createdAt.getUTCFullYear()).toBe(2026);
  });

  it('writes an audit entry for every state change, in order', async () => {
    const created = await request({ amount: 10n * ETH, idempotencyKey: 'audit' });
    service.approve(created.id, 'admin-1');
    await service.process(created.id);
    await service.confirm(created.id);

    const trail = audit.entries().map((e) => [e.actor, e.action, e.details?.['from']]);
    expect(trail).toEqual([
      ['alice', 'withdrawal.requested', undefined],
      ['system', 'withdrawal.pending_approval', undefined],
      ['admin-1', 'withdrawal.approved', 'pending_approval'],
      ['system', 'withdrawal.signed', 'approved'],
      ['system', 'withdrawal.broadcast', 'signed'],
      ['system', 'withdrawal.confirmed', 'broadcast'],
    ]);
    expect(audit.entries().every((e) => e.withdrawalId === created.id && e.userId === 'alice')).toBe(true);
  });

  it('audits denied requests and freezes', async () => {
    service.freeze('alice', 'admin-1');
    await expectCode(request(), 'USER_FROZEN');

    expect(audit.entries().map((e) => [e.actor, e.action, e.details?.['code']])).toEqual([
      ['admin-1', 'user.frozen', undefined],
      ['alice', 'withdrawal.denied', 'USER_FROZEN'],
    ]);
  });
});
