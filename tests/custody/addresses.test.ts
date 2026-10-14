import { describe, expect, it } from 'vitest';
import { isAddress } from 'viem';
import { english, generateMnemonic } from 'viem/accounts';
import { AddressBook, deriveDepositAddress } from '../../src/custody/addresses.js';

describe('deriveDepositAddress', () => {
  const mnemonic = generateMnemonic(english);

  it('derives the same checksummed address for the same index', () => {
    const address = deriveDepositAddress(mnemonic, 0);
    expect(isAddress(address, { strict: true })).toBe(true);
    expect(deriveDepositAddress(mnemonic, 0)).toBe(address);
  });

  it('derives a distinct address for every index', () => {
    const addresses = Array.from({ length: 5 }, (_, i) => deriveDepositAddress(mnemonic, i));
    expect(new Set(addresses).size).toBe(5);
  });

  it('derives different addresses from a different mnemonic', () => {
    const other = generateMnemonic(english);
    expect(deriveDepositAddress(other, 0)).not.toBe(deriveDepositAddress(mnemonic, 0));
  });

  it('rejects a negative or fractional index', () => {
    expect(() => deriveDepositAddress(mnemonic, -1)).toThrow();
    expect(() => deriveDepositAddress(mnemonic, 1.5)).toThrow();
  });
});

describe('AddressBook', () => {
  const address = deriveDepositAddress(generateMnemonic(english), 0);

  it('resolves an address in any letter case', () => {
    const book = new AddressBook();
    book.assign(address, 'u1');
    expect(book.resolve(address.toLowerCase())).toBe('u1');
    expect(book.resolve(`0x${address.slice(2).toUpperCase()}`)).toBe('u1');
  });

  it('refuses to give one address to two users', () => {
    const book = new AddressBook();
    book.assign(address, 'u1');
    expect(() => book.assign(address.toLowerCase(), 'u2')).toThrow(/another user/);
  });
});
