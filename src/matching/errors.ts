export type RejectCode =
  | 'INVALID_SEQ'
  | 'DUPLICATE_ORDER_ID'
  | 'INVALID_QTY'
  | 'INVALID_LOT'
  | 'MISSING_PRICE'
  | 'UNEXPECTED_PRICE'
  | 'INVALID_PRICE'
  | 'INVALID_TICK';

/**
 * Thrown when a command fails validation. The engine checks everything before
 * touching state, so a rejected command leaves the book exactly as it was.
 */
export class OrderRejected extends Error {
  readonly code: RejectCode;

  constructor(code: RejectCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OrderRejected';
    this.code = code;
  }
}
