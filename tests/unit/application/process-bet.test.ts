import { describe, expect, test } from 'bun:test';

import {
  InvalidBetError,
  ProcessBetUseCase,
  type BetPersistence,
  type ProcessBetInput,
  type ProcessBetOutput,
} from '../../../src/application/wagering/process-bet.use-case';

const validInput: ProcessBetInput = {
  walletId: 'wallet-1',
  providerId: 'provider-a',
  externalTransactionId: 'bet-1',
  amount: '30.00',
  currency: 'BRL',
};

const processedOutput: ProcessBetOutput = {
  transactionId: 'transaction-1',
  walletId: 'wallet-1',
  status: 'PROCESSED',
  balanceAfter: '70.00',
  reason: null,
};

describe('ProcessBetUseCase', () => {
  test('should submit a valid bet to persistence', async () => {
    let received: ProcessBetInput | undefined;

    const persistence: BetPersistence = {
      async processBet(input) {
        received = input;
        return processedOutput;
      },
    };

    const useCase = new ProcessBetUseCase(persistence);

    const result = await useCase.execute(validInput);

    expect(received).toEqual(validInput);
    expect(result.status).toBe('PROCESSED');
    expect(result.balanceAfter).toBe('70.00');
  });

  test('should reject invalid monetary amounts', async () => {
    let called = false;

    const persistence: BetPersistence = {
      async processBet() {
        called = true;
        return processedOutput;
      },
    };

    const useCase = new ProcessBetUseCase(persistence);

    for (const amount of ['0.00', '-10.00', '10.123']) {
      await expect(useCase.execute({ ...validInput, amount })).rejects.toBeInstanceOf(
        InvalidBetError,
      );
    }

    expect(called).toBe(false);
  });

  test('should preserve a rejected transaction result', async () => {
    const persistence: BetPersistence = {
      async processBet() {
        return {
          ...processedOutput,
          status: 'REJECTED',
          balanceAfter: '20.00',
          reason: 'INSUFFICIENT_FUNDS',
        };
      },
    };

    const useCase = new ProcessBetUseCase(persistence);

    const result = await useCase.execute(validInput);

    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('INSUFFICIENT_FUNDS');
  });
});
