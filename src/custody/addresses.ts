import { getAddress, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

/** Deposit address #index on the standard EVM path m/44'/60'/0'/0/index. */
export function deriveDepositAddress(mnemonic: string, index: number): `0x${string}` {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Address index must be a non-negative integer, got ${index}`);
  }
  return mnemonicToAccount(mnemonic, { addressIndex: index }).address;
}

/**
 * Checksummed form of an address. Lowercasing first means any casing is accepted:
 * deposits are matched by value, and a sender's broken checksum is not our concern.
 */
export function normalizeAddress(address: string): Address {
  return getAddress(address.toLowerCase());
}

/** Maps deposit addresses to the users who own them, ignoring letter case. */
export class AddressBook {
  private readonly owners = new Map<Address, string>();

  assign(address: string, userId: string): void {
    const key = normalizeAddress(address);
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== userId) {
      throw new Error(`Address ${key} already belongs to another user`);
    }
    this.owners.set(key, userId);
  }

  resolve(address: string): string | undefined {
    return this.owners.get(normalizeAddress(address));
  }
}
