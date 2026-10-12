import { LedgerEntry, type LedgerDirection, type LedgerOperation } from '../ledger/ledger-entry';
import { Money } from '../money/money';

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export interface WalletMovement {
  wallet: Wallet;
  entry: LedgerEntry;
}

interface MovementInput {
  entryId: string;
  transactionId: string | null;
  operation: LedgerOperation;
  amount: Money;
  direction: LedgerDirection;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly balance: Money,
  ) {
    Object.freeze(this);
  }

  get currency(): string {
    return this.balance.currency;
  }

  static open(input: {
    id: string;
    playerId: string;
    currency: string;
    openingBalance?: Money;
    openingEntryId?: string;
  }): {
    wallet: Wallet;
    openingEntry: LedgerEntry | null;
  } {
    if (!input.id.trim() || !input.playerId.trim()) {
      throw new Error('Wallet identifiers are required');
    }

    const zero = Money.zero(input.currency);
    const initialBalance = input.openingBalance ?? zero;

    if (initialBalance.currency !== input.currency) {
      throw new Error('Currency mismatch');
    }

    if (initialBalance.isNegative()) {
      throw new Error('Opening balance cannot be negative');
    }

    const wallet = new Wallet(input.id, input.playerId, zero);

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: null };
    }

    if (!input.openingEntryId) {
      throw new Error('Opening ledger entry ID is required');
    }

    const result = wallet.credit({
      entryId: input.openingEntryId,
      transactionId: null,
      operation: 'OPENING',
      amount: initialBalance,
    });

    return {
      wallet: result.wallet,
      openingEntry: result.entry,
    };
  }

  debit(input: {
    entryId: string;
    transactionId: string;
    operation: 'BET' | 'ROLLBACK';
    amount: Money;
  }): WalletMovement {
    return this.applyMovement({
      ...input,
      direction: 'DEBIT',
    });
  }

  credit(input: {
    entryId: string;
    transactionId: string | null;
    operation: 'OPENING' | 'WIN' | 'REFUND' | 'ROLLBACK';
    amount: Money;
  }): WalletMovement {
    return this.applyMovement({
      ...input,
      direction: 'CREDIT',
    });
  }

  static restore(input: { id: string; playerId: string; balance: Money }): Wallet {
    if (!input.id.trim() || !input.playerId.trim()) {
      throw new Error('Wallet identifiers are required');
    }

    if (input.balance.isNegative()) {
      throw new Error('Wallet balance cannot be negative');
    }

    return new Wallet(input.id, input.playerId, input.balance);
  }

  private applyMovement(input: MovementInput): WalletMovement {
    if (input.amount.currency !== this.currency) {
      throw new Error('Currency mismatch');
    }

    if (!input.amount.isGreaterThan(Money.zero(this.currency))) {
      throw new Error('Movement amount must be positive');
    }

    const nextBalance =
      input.direction === 'DEBIT'
        ? this.balance.subtract(input.amount)
        : this.balance.add(input.amount);

    if (nextBalance.isNegative()) {
      throw new InsufficientFundsError();
    }

    const entry = LedgerEntry.create({
      id: input.entryId,
      walletId: this.id,
      transactionId: input.transactionId,
      operation: input.operation,
      direction: input.direction,
      amount: input.amount,
      balanceBefore: this.balance,
      balanceAfter: nextBalance,
    });

    const updatedWallet = new Wallet(this.id, this.playerId, nextBalance);

    return {
      wallet: updatedWallet,
      entry,
    };
  }
}
