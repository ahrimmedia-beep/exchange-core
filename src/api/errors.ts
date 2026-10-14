import { WithdrawalError } from '../custody/withdrawals.js';
import { ExchangeError } from '../exchange/exchange-service.js';
import { InvalidAmountError } from '../ledger/money.js';
import { InsufficientFundsError, LedgerError } from '../ledger/types.js';
import { OrderRejected } from '../matching/errors.js';
import { IdempotencyKeyReusedError } from './idempotency.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const EXCHANGE_STATUS: Record<ExchangeError['code'], number> = {
  UNKNOWN_MARKET: 404,
  ORDER_NOT_FOUND: 404,
  ORDER_NOT_OPEN: 409,
  NO_LIQUIDITY: 422,
  MARKET_HALTED: 503,
};

const WITHDRAWAL_STATUS: Record<WithdrawalError['code'], number> = {
  INVALID_AMOUNT: 400,
  INVALID_ADDRESS: 400,
  UNSUPPORTED_ASSET: 400,
  USER_FROZEN: 403,
  SELF_APPROVAL: 403,
  DAILY_LIMIT_EXCEEDED: 422,
  IDEMPOTENCY_CONFLICT: 422,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  IN_PROGRESS: 409,
};

/** Maps domain errors to HTTP. Anything not listed is a bug and becomes a generic 500. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof InsufficientFundsError) return new HttpError(422, err.code, 'insufficient funds');
  if (err instanceof LedgerError) {
    return new HttpError(err.code === 'IDEMPOTENCY_CONFLICT' ? 422 : 400, err.code, err.message);
  }
  if (err instanceof OrderRejected) return new HttpError(400, err.code, err.message);
  if (err instanceof InvalidAmountError) return new HttpError(400, err.code, err.message);
  if (err instanceof ExchangeError) return new HttpError(EXCHANGE_STATUS[err.code], err.code, err.message);
  if (err instanceof WithdrawalError) return new HttpError(WITHDRAWAL_STATUS[err.code], err.code, err.message);
  if (err instanceof IdempotencyKeyReusedError) return new HttpError(422, err.code, err.message);
  const validation = err as { validation?: unknown; message?: string };
  if (validation.validation) return new HttpError(400, 'VALIDATION_ERROR', validation.message ?? 'invalid request');
  return new HttpError(500, 'INTERNAL', 'internal error');
}
