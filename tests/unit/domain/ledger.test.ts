import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { LedgerEntry, type LedgerEntryInput } from '../../../src/domain/ledger/ledger-entry';

function createEntry(overrides: Partial<LedgerEntryInput> = {}): LedgerEntry {
  return LedgerEntry.create({
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'bet-1',
    operation: 'BET',
    direction: 'DEBIT',
    amount: Money.from('30.00', 'BRL'),
    balanceBefore: Money.from('100.00', 'BRL'),
    balanceAfter: Money.from('70.00', 'BRL'),
    ...overrides,
  });
}

describe('LedgerEntry', () => {
  test('should create a valid debit entry', () => {
    const entry = createEntry();

    expect(entry.operation).toBe('BET');
    expect(entry.direction).toBe('DEBIT');
    expect(entry.amount.toString()).toBe('30.00');
    expect(entry.balanceAfter.toString()).toBe('70.00');
  });

  test('should reject inconsistent balances', () => {
    expect(() =>
      createEntry({
        balanceAfter: Money.from('90.00', 'BRL'),
      }),
    ).toThrow('Inconsistent ledger balance');
  });

  test('should reject invalid operation direction', () => {
    expect(() =>
      createEntry({
        direction: 'CREDIT',
      }),
    ).toThrow('Invalid ledger operation direction');
  });

  test('should reject non-positive amounts', () => {
    expect(() =>
      createEntry({
        amount: Money.from('0.00', 'BRL'),
      }),
    ).toThrow('Ledger amount must be positive');
  });

  test('should reject entries without transaction reference', () => {
    expect(() =>
      createEntry({
        transactionId: null,
      }),
    ).toThrow('Transaction ID is required');
  });

  test('should reject negative final balances', () => {
    expect(() =>
      createEntry({
        amount: Money.from('130.00', 'BRL'),
        balanceAfter: Money.from('-30.00', 'BRL'),
      }),
    ).toThrow('Ledger balances cannot be negative');
  });

  test('should reject currencies that do not match', () => {
    expect(() =>
      createEntry({
        amount: Money.from('30.00', 'USD'),
      }),
    ).toThrow('Currency mismatch');
  });

  test('should be frozen after creation', () => {
    const entry = createEntry();

    expect(Object.isFrozen(entry)).toBe(true);
  });
});
