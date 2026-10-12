import { Money } from '../money/money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export type LedgerOperation = 'OPENING' | 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';

export interface LedgerEntryInput {
  id: string;
  walletId: string;
  transactionId: string | null;
  operation: LedgerOperation;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

const allowedDirections: Record<LedgerOperation, readonly LedgerDirection[]> = {
  OPENING: ['CREDIT'],
  BET: ['DEBIT'],
  WIN: ['CREDIT'],
  REFUND: ['CREDIT'],
  ROLLBACK: ['DEBIT', 'CREDIT'],
};

export class LedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string | null;
  readonly operation: LedgerOperation;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly occurredAt: string;

  private constructor(input: LedgerEntryInput) {
    this.id = input.id;
    this.walletId = input.walletId;
    this.transactionId = input.transactionId;
    this.operation = input.operation;
    this.direction = input.direction;
    this.amount = input.amount;
    this.balanceBefore = input.balanceBefore;
    this.balanceAfter = input.balanceAfter;
    this.occurredAt = new Date().toISOString();

    Object.freeze(this);
  }

  static create(input: LedgerEntryInput): LedgerEntry {
    if (!input.id.trim() || !input.walletId.trim()) {
      throw new Error('Ledger identifiers are required');
    }

    if (!allowedDirections[input.operation].includes(input.direction)) {
      throw new Error('Invalid ledger operation direction');
    }

    if (input.operation === 'OPENING') {
      if (input.transactionId !== null) {
        throw new Error('OPENING cannot reference a transaction');
      }

      if (!input.balanceBefore.isZero()) {
        throw new Error('OPENING requires zero starting balance');
      }
    } else if (!input.transactionId?.trim()) {
      throw new Error('Transaction ID is required');
    }

    const zero = Money.zero(input.amount.currency);

    if (!input.amount.isGreaterThan(zero)) {
      throw new Error('Ledger amount must be positive');
    }

    if (
      input.balanceBefore.currency !== input.amount.currency ||
      input.balanceAfter.currency !== input.amount.currency
    ) {
      throw new Error('Currency mismatch');
    }

    if (input.balanceBefore.isNegative() || input.balanceAfter.isNegative()) {
      throw new Error('Ledger balances cannot be negative');
    }

    const expectedBalance =
      input.direction === 'CREDIT'
        ? input.balanceBefore.add(input.amount)
        : input.balanceBefore.subtract(input.amount);

    if (!expectedBalance.equals(input.balanceAfter)) {
      throw new Error('Inconsistent ledger balance');
    }

    return new LedgerEntry(input);
  }
}
