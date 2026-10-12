import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { ProcessOutcomeUseCase } from '../../src/application/wagering/process-outcome.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

describe('Ledger reference constraints', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  async function createWallet(): Promise<string> {
    const wallet = await new CreateWalletUseCase(
      new PostgresWalletRepository(orm.em.fork()),
    ).execute({
      playerId: `ledger-constraint-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return wallet.id;
  }

  interface LedgerInput {
    walletId: string;
    transactionId: string | null;
    operation: string;
    direction: 'CREDIT' | 'DEBIT';
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
  }

  async function expectConstraintViolation(
    input: LedgerInput,
    constraintName: string,
  ): Promise<void> {
    let failure: unknown;

    try {
      await orm.em.fork().transactional(async (tx) => {
        await tx.execute(
          `
          INSERT INTO public.wallet_ledger_entries (
            id,
            wallet_id,
            transaction_id,
            operation,
            direction,
            amount,
            balance_before,
            balance_after,
            occurred_at
          )
          VALUES (
            ?::uuid,
            ?::uuid,
            ?::uuid,
            ?,
            ?,
            ?::numeric,
            ?::numeric,
            ?::numeric,
            NOW()
          )
          `,
          [
            randomUUID(),
            input.walletId,
            input.transactionId,
            input.operation,
            input.direction,
            input.amount,
            input.balanceBefore,
            input.balanceAfter,
          ],
        );

        // Se o banco aceitou a inserção, forçamos
        // rollback para não contaminar o banco de testes.
        throw new Error('UNEXPECTED_INSERT_SUCCESS');
      });
    } catch (error: unknown) {
      failure = error;
    }

    const message = String(failure);

    if (!failure || message.includes('UNEXPECTED_INSERT_SUCCESS')) {
      throw new Error(`Database accepted an invalid ledger entry: ${constraintName}`);
    }

    // Garante que falhou pela proteção esperada,
    // não por um erro SQL não relacionado.
    expect(message).toContain(constraintName);
  }

  test('should reject a nonexistent transaction reference', async () => {
    const walletId = await createWallet();

    await expectConstraintViolation(
      {
        walletId,
        transactionId: randomUUID(),
        operation: 'BET',
        direction: 'DEBIT',
        amount: '1.00',
        balanceBefore: '100.00',
        balanceAfter: '99.00',
      },
      'fk_ledger_transaction_same_wallet',
    );
  });

  test('should reject a transaction belonging to another wallet', async () => {
    const walletA = await createWallet();
    const walletB = await createWallet();

    // LOSS processada não gera ledger.
    // Assim, usamos um transactionId existente
    // sem esbarrar numa possível constraint de
    // unicidade por transaction_id.
    const loss = await new ProcessOutcomeUseCase(new PostgresBetRepository(orm.em.fork())).execute({
      walletId: walletA,
      providerId: 'ledger-constraint-provider',
      externalTransactionId: randomUUID(),
      type: 'LOSS',
      amount: '1.00',
      currency: 'BRL',
    });

    expect(loss.status).toBe('PROCESSED');

    await expectConstraintViolation(
      {
        walletId: walletB,
        transactionId: loss.transactionId,
        operation: 'BET',
        direction: 'DEBIT',
        amount: '1.00',
        balanceBefore: '100.00',
        balanceAfter: '99.00',
      },
      'fk_ledger_transaction_same_wallet',
    );
  });

  test('should reject a second OPENING for one wallet', async () => {
    const walletId = await createWallet();

    await expectConstraintViolation(
      {
        walletId,
        transactionId: null,
        operation: 'OPENING',
        direction: 'CREDIT',
        amount: '1.00',
        balanceBefore: '0.00',
        balanceAfter: '1.00',
      },
      'uq_ledger_one_opening_per_wallet',
    );
  });

  test('should reject BET ledger without transaction ID', async () => {
    const walletId = await createWallet();

    await expectConstraintViolation(
      {
        walletId,
        transactionId: null,
        operation: 'BET',
        direction: 'DEBIT',
        amount: '1.00',
        balanceBefore: '100.00',
        balanceAfter: '99.00',
      },
      'ck_ledger_reference_by_operation',
    );
  });
});
