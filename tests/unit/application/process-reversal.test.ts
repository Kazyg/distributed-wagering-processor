import { describe, expect, test } from 'bun:test';

import {
  InvalidReversalError,
  ProcessReversalUseCase,
  type ProcessReversalInput,
  type ReversalPersistence,
} from '../../../src/application/wagering/process-reversal.use-case';

import type { ProcessBetOutput } from '../../../src/application/wagering/process-bet.use-case';

const validInput: ProcessReversalInput = {
  walletId: 'wallet-1',
  providerId: 'provider-a',
  externalTransactionId: 'refund-123',
  referenceExternalTransactionId: 'bet-123',
  type: 'REFUND',
  amount: '30.00',
  currency: 'BRL',
};

const output: ProcessBetOutput = {
  transactionId: 'transaction-1',
  walletId: 'wallet-1',
  status: 'PROCESSED',
  balanceAfter: '100.00',
  reason: null,
};

describe('ProcessReversalUseCase', () => {
  test('should submit a valid REFUND', async () => {
    let received: ProcessReversalInput | undefined;

    const persistence: ReversalPersistence = {
      async processReversal(input) {
        received = input;
        return output;
      },
    };

    const result = await new ProcessReversalUseCase(persistence).execute(validInput);

    expect(result).toEqual(output);
    expect(received).toEqual(validInput);
  });

  test('should accept ROLLBACK', async () => {
    let receivedType: string | undefined;

    const persistence: ReversalPersistence = {
      async processReversal(input) {
        receivedType = input.type;
        return output;
      },
    };

    await new ProcessReversalUseCase(persistence).execute({
      ...validInput,
      type: 'ROLLBACK',
    });

    expect(receivedType).toBe('ROLLBACK');
  });

  test('should reject missing and self references', async () => {
    let called = false;

    const persistence: ReversalPersistence = {
      async processReversal() {
        called = true;
        return output;
      },
    };

    const useCase = new ProcessReversalUseCase(persistence);

    await expect(
      useCase.execute({
        ...validInput,
        referenceExternalTransactionId: '',
      }),
    ).rejects.toBeInstanceOf(InvalidReversalError);

    await expect(
      useCase.execute({
        ...validInput,
        referenceExternalTransactionId: validInput.externalTransactionId,
      }),
    ).rejects.toBeInstanceOf(InvalidReversalError);

    expect(called).toBe(false);
  });
});
