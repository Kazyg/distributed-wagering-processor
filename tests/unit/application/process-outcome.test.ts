import { describe, expect, test } from 'bun:test';

import {
  ProcessOutcomeUseCase,
  type OutcomePersistence,
  type ProcessOutcomeInput,
} from '../../../src/application/wagering/process-outcome.use-case';

import {
  InvalidBetError,
  type ProcessBetOutput,
} from '../../../src/application/wagering/process-bet.use-case';

const validInput: ProcessOutcomeInput = {
  type: 'WIN',
  walletId: 'wallet-1',
  providerId: 'provider-a',
  externalTransactionId: 'win-1',
  amount: '50.00',
  currency: 'BRL',
};

const processedOutput: ProcessBetOutput = {
  transactionId: 'transaction-1',
  walletId: 'wallet-1',
  status: 'PROCESSED',
  balanceAfter: '150.00',
  reason: null,
};

describe('ProcessOutcomeUseCase', () => {
  test('should submit a valid WIN', async () => {
    let received: ProcessOutcomeInput | undefined;

    const persistence: OutcomePersistence = {
      async processOutcome(input) {
        received = input;
        return processedOutput;
      },
    };

    const useCase = new ProcessOutcomeUseCase(persistence);

    const result = await useCase.execute(validInput);

    expect(received).toEqual(validInput);
    expect(result.status).toBe('PROCESSED');
  });

  test('should submit a valid LOSS', async () => {
    let receivedType: string | undefined;

    const persistence: OutcomePersistence = {
      async processOutcome(input) {
        receivedType = input.type;

        return {
          ...processedOutput,
          balanceAfter: '100.00',
        };
      },
    };

    const useCase = new ProcessOutcomeUseCase(persistence);

    const result = await useCase.execute({
      ...validInput,
      type: 'LOSS',
    });

    expect(receivedType).toBe('LOSS');
    expect(result.balanceAfter).toBe('100.00');
  });

  test('should reject invalid outcome amounts', async () => {
    let called = false;

    const persistence: OutcomePersistence = {
      async processOutcome() {
        called = true;
        return processedOutput;
      },
    };

    const useCase = new ProcessOutcomeUseCase(persistence);

    for (const amount of ['0.00', '-10.00', '10.123']) {
      await expect(
        useCase.execute({
          ...validInput,
          amount,
        }),
      ).rejects.toBeInstanceOf(InvalidBetError);
    }

    expect(called).toBe(false);
  });
});
