import { Money } from '../../domain/money/money';

export const PROCESS_BET_USE_CASE = Symbol('PROCESS_BET_USE_CASE');
import type {
  WagerStatus,
  TransactionRejectionReason,
} from '../../domain/wagering-transaction/transaction-status';

export interface ProcessBetInput {
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  amount: string;
  currency: string;
}

export interface ProcessBetOutput {
  transactionId: string;
  walletId: string;
  status: WagerStatus;
  reason: TransactionRejectionReason | null;
  balanceAfter: string;
}

export interface BetPersistence {
  processBet(input: ProcessBetInput): Promise<ProcessBetOutput>;
}

export class InvalidBetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBetError';
  }
}

export class WalletNotFoundError extends Error {
  constructor() {
    super('Wallet not found');
    this.name = 'WalletNotFoundError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key already used with different payload');
    this.name = 'IdempotencyConflictError';
  }
}

export function validateWagerInput(input: ProcessBetInput): ProcessBetInput {
  if (
    !input.walletId?.trim() ||
    !input.providerId?.trim() ||
    !input.externalTransactionId?.trim()
  ) {
    throw new InvalidBetError('Transaction identifiers are required');
  }

  let amount: Money;

  try {
    amount = Money.from(input.amount, input.currency);
  } catch {
    throw new InvalidBetError('Invalid amount or currency');
  }

  if (!amount.isGreaterThan(Money.zero(input.currency))) {
    throw new InvalidBetError('Transaction amount must be positive');
  }

  return {
    ...input,
    amount: amount.toString(),
  };
}

export class ProcessBetUseCase {
  constructor(private readonly persistence: BetPersistence) {}

  async execute(input: ProcessBetInput): Promise<ProcessBetOutput> {
    const validated = validateWagerInput(input);

    return this.persistence.processBet(validated);
  }
}
