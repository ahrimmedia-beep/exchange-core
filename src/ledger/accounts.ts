/**
 * Account naming. An account id is a readable string so that journal rows can be audited
 * by eye in SQL without joins:
 *
 *   user:<userId>:<asset>:available   funds the user can trade or withdraw
 *   user:<userId>:<asset>:locked      funds reserved by open orders or pending withdrawals
 *   fees:<asset>                      fees earned by the exchange
 *   custody:<asset>                   counter-account for on-chain holdings
 *
 * custody:<asset> is a contra account: a deposit moves value from custody to the user, so
 * custody goes negative. At any moment -balance(custody:X) is what the hot wallet should
 * hold, which turns chain reconciliation into a single comparison.
 */

export type Bucket = 'available' | 'locked';

const SEGMENT_RE = /^[A-Za-z0-9_.@-]+$/;

function segment(value: string, what: string): string {
  if (!SEGMENT_RE.test(value)) throw new Error(`invalid ${what}: "${value}"`);
  return value;
}

export function userAccount(userId: string, asset: string, bucket: Bucket): string {
  return `user:${segment(userId, 'user id')}:${segment(asset, 'asset')}:${bucket}`;
}

export function feesAccount(asset: string): string {
  return `fees:${segment(asset, 'asset')}`;
}

export function custodyAccount(asset: string): string {
  return `custody:${segment(asset, 'asset')}`;
}

/** Only the contra account may go below zero. Users and the fee pool never can. */
export function mayGoNegative(accountId: string): boolean {
  return accountId.startsWith('custody:');
}

export function assetOf(accountId: string): string {
  const parts = accountId.split(':');
  const asset = parts[0] === 'user' ? parts[2] : parts[1];
  if (!asset) throw new Error(`malformed account id: "${accountId}"`);
  return asset;
}

export function parseUserAccount(
  accountId: string,
): { userId: string; asset: string; bucket: Bucket } | null {
  const [kind, userId, asset, bucket] = accountId.split(':');
  if (kind !== 'user' || !userId || !asset) return null;
  if (bucket !== 'available' && bucket !== 'locked') return null;
  return { userId, asset, bucket };
}
