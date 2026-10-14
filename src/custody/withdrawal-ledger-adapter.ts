import type { Ledger } from '../ledger/ledger.js';
import type { WithdrawalLedger } from './withdrawals.js';

/**
 * Connects the withdrawal state machine to the double-entry ledger. The withdrawal
 * service only knows three movements; each one maps to one journal entry and reuses the
 * service's idempotency key, so a retried step can never move funds twice.
 */
export function withdrawalLedger(ledger: Ledger): WithdrawalLedger {
  return {
    async lock(userId, asset, amount, key) {
      await ledger.requestWithdrawal({ userId, asset, amount, idempotencyKey: key, ref: key });
    },
    async release(userId, asset, amount, key) {
      await ledger.failWithdrawal({ userId, asset, amount, idempotencyKey: key, ref: key });
    },
    async settle(userId, asset, amount, key) {
      await ledger.completeWithdrawal({ userId, asset, amount, idempotencyKey: key, ref: key });
    },
  };
}
