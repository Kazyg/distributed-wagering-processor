import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { InsufficientFundsError, Wallet } from '../../../src/domain/wallet/wallet';

function createFundedWallet() {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    openingBalance: Money.from('100.00', 'BRL'),
    openingEntryId: 'opening-1',
  }).wallet;
}

describe('Wallet', () => {
  test('should open a wallet with zero balance', () => {
    const result = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
    });

    expect(result.wallet.balance.toString()).toBe('0.00');
    expect(result.openingEntry).toBeNull();
  });

  test('should generate an opening ledger entry', () => {
    const result = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      openingBalance: Money.from('100.00', 'BRL'),
      openingEntryId: 'opening-1',
    });

    expect(result.wallet.balance.toString()).toBe('100.00');
    expect(result.openingEntry?.operation).toBe('OPENING');
    expect(result.openingEntry?.direction).toBe('CREDIT');
    expect(result.openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(result.openingEntry?.balanceAfter.toString()).toBe('100.00');
  });

  test('should debit a bet correctly', () => {
    const wallet = createFundedWallet();

    const result = wallet.debit({
      entryId: 'ledger-1',
      transactionId: 'bet-1',
      operation: 'BET',
      amount: Money.from('30.00', 'BRL'),
    });

    expect(result.wallet.balance.toString()).toBe('70.00');
    expect(result.entry.direction).toBe('DEBIT');
    expect(result.entry.balanceBefore.toString()).toBe('100.00');
    expect(result.entry.balanceAfter.toString()).toBe('70.00');
  });

  test('should reject insufficient funds', () => {
    const wallet = createFundedWallet();

    expect(() =>
      wallet.debit({
        entryId: 'ledger-1',
        transactionId: 'bet-1',
        operation: 'BET',
        amount: Money.from('150.00', 'BRL'),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('should allow spending the exact available balance', () => {
    const wallet = createFundedWallet();

    const result = wallet.debit({
      entryId: 'ledger-1',
      transactionId: 'bet-1',
      operation: 'BET',
      amount: Money.from('100.00', 'BRL'),
    });

    expect(result.wallet.balance.toString()).toBe('0.00');
  });

  test('should credit winnings correctly', () => {
    const wallet = createFundedWallet();

    const result = wallet.credit({
      entryId: 'ledger-1',
      transactionId: 'win-1',
      operation: 'WIN',
      amount: Money.from('50.00', 'BRL'),
    });

    expect(result.wallet.balance.toString()).toBe('150.00');
    expect(result.entry.operation).toBe('WIN');
    expect(result.entry.direction).toBe('CREDIT');
  });

  test('should reject different currencies', () => {
    const wallet = createFundedWallet();

    expect(() =>
      wallet.debit({
        entryId: 'ledger-1',
        transactionId: 'bet-1',
        operation: 'BET',
        amount: Money.from('10.00', 'USD'),
      }),
    ).toThrow('Currency mismatch');
  });

  test('should reject zero and negative movement amounts', () => {
    const wallet = createFundedWallet();

    for (const amount of ['0.00', '-10.00']) {
      expect(() =>
        wallet.debit({
          entryId: 'ledger-1',
          transactionId: 'bet-1',
          operation: 'BET',
          amount: Money.from(amount, 'BRL'),
        }),
      ).toThrow('Movement amount must be positive');
    }
  });

  test('should preserve the original wallet', () => {
    const wallet = createFundedWallet();

    const result = wallet.debit({
      entryId: 'ledger-1',
      transactionId: 'bet-1',
      operation: 'BET',
      amount: Money.from('25.00', 'BRL'),
    });

    expect(wallet.balance.toString()).toBe('100.00');
    expect(result.wallet.balance.toString()).toBe('75.00');
    expect(result.wallet).not.toBe(wallet);
  });

  test('should reject negative opening balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        openingBalance: Money.from('-10.00', 'BRL'),
        openingEntryId: 'opening-1',
      }),
    ).toThrow('Opening balance cannot be negative');
  });

  test('should reject opening funds without a ledger entry ID', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        openingBalance: Money.from('50.00', 'BRL'),
      }),
    ).toThrow('Opening ledger entry ID is required');
  });
});
