import type { OutcomeOperation } from '../../domain/wagering-transaction/wager-operation';

import {
  InvalidBetError,
  validateWagerInput,
  type ProcessBetInput,
  type ProcessBetOutput,
} from './process-bet.use-case';

export const PROCESS_OUTCOME_USE_CASE = Symbol('PROCESS_OUTCOME_USE_CASE');

export interface ProcessOutcomeInput extends ProcessBetInput {
  type: OutcomeOperation;
}

export interface OutcomePersistence {
  processOutcome(input: ProcessOutcomeInput): Promise<ProcessBetOutput>;
}

export class ProcessOutcomeUseCase {
  constructor(private readonly persistence: OutcomePersistence) {}

  async execute(input: ProcessOutcomeInput): Promise<ProcessBetOutput> {
    if (input.type !== 'WIN' && input.type !== 'LOSS') {
      throw new InvalidBetError('Unsupported outcome type');
    }

    const validated = validateWagerInput(input);

    return this.persistence.processOutcome({
      ...validated,
      type: input.type,
    });
  }
}
