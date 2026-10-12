import type { ReversalOperation } from '../../domain/wagering-transaction/wager-operation';

import {
  InvalidBetError,
  validateWagerInput,
  type ProcessBetInput,
  type ProcessBetOutput,
} from './process-bet.use-case';

export const PROCESS_REVERSAL_USE_CASE = Symbol('PROCESS_REVERSAL_USE_CASE');

export interface ProcessReversalInput extends ProcessBetInput {
  type: ReversalOperation;
  referenceExternalTransactionId: string;
}

export interface ReversalPersistence {
  processReversal(input: ProcessReversalInput): Promise<ProcessBetOutput>;
}

export class ReferenceNotFoundError extends Error {
  constructor() {
    super('Referenced transaction is not available yet');
    this.name = 'ReferenceNotFoundError';
  }
}

export class InvalidReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReversalError';
  }
}

export class ReferenceAlreadyReversedError extends Error {
  constructor() {
    super('Referenced transaction already has a processed reversal');
    this.name = 'ReferenceAlreadyReversedError';
  }
}

export class ProcessReversalUseCase {
  constructor(private readonly persistence: ReversalPersistence) {}

  async execute(input: ProcessReversalInput): Promise<ProcessBetOutput> {
    if (input.type !== 'REFUND' && input.type !== 'ROLLBACK') {
      throw new InvalidBetError('Unsupported reversal type');
    }

    const reference = input.referenceExternalTransactionId;

    if (typeof reference !== 'string' || !reference.trim() || reference.length > 128) {
      throw new InvalidReversalError('Reference external transaction ID is required');
    }

    if (reference === input.externalTransactionId) {
      throw new InvalidReversalError('A transaction cannot reference itself');
    }

    const validated = validateWagerInput(input);

    return this.persistence.processReversal({
      ...validated,
      type: input.type,
      referenceExternalTransactionId: reference,
    });
  }
}
