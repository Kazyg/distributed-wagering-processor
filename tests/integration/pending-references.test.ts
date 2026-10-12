import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/wagering/process-bet.use-case';
import { ProcessReversalUseCase } from '../../src/application/wagering/process-reversal.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities/wager-transaction.entity';

describe('Pending references integration', () => {
  let orm: MikroORM;

  const providerId = 'pending-reference-tests';

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  function repository(): PostgresBetRepository {
    return new PostgresBetRepository(orm.em.fork());
  }

  async function createWallet(): Promise<string> {
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const result = await creator.execute({
      playerId: `pending-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return result.id;
  }

  async function createPendingRefund(
    walletId: string,
    referenceExternalTransactionId: string,
    externalTransactionId = randomUUID(),
  ) {
    return new ProcessReversalUseCase(repository()).execute({
      walletId,
      providerId,
      externalTransactionId,
      referenceExternalTransactionId,
      type: 'REFUND',
      amount: '30.00',
      currency: 'BRL',
    });
  }

  async function createOriginalBet(walletId: string, externalTransactionId: string) {
    return new ProcessBetUseCase(repository()).execute({
      walletId,
      providerId,
      externalTransactionId,
      amount: '30.00',
      currency: 'BRL',
    });
  }

  async function makeRetryDue(transactionId: string): Promise<void> {
    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
      UPDATE public.wager_transactions
      SET next_retry_at = NOW() - INTERVAL '1 second'
      WHERE id = ?
      `,
        [transactionId],
      );
  }

  test('should persist missing reference without changing balance', async () => {
    const walletId = await createWallet();

    const result = await createPendingRefund(walletId, randomUUID());

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const wager = await em.findOneOrFail(WagerTransactionEntity, { id: result.transactionId });

    const entries = await em.find(WalletLedgerEntryEntity, { wallet: walletId });

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(wallet.balance).toBe('100.00');
    expect(wager.retryCount).toBe(0);
    expect(wager.nextRetryAt).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.operation).toBe('OPENING');
  });

  test('should process REFUND after its BET arrives', async () => {
    const walletId = await createWallet();
    const betExternalId = randomUUID();

    const pending = await createPendingRefund(walletId, betExternalId);

    expect(pending.status).toBe('PENDING_REFERENCE');

    const bet = await createOriginalBet(walletId, betExternalId);

    expect(bet.balanceAfter).toBe('70.00');

    await makeRetryDue(pending.transactionId);

    const processed = await repository().processNextPending(pending.transactionId);

    expect(processed).toBe('PROCESSED');

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const refund = await em.findOneOrFail(WagerTransactionEntity, { id: pending.transactionId });

    const refundEntries = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'REFUND',
    });

    expect(wallet.balance).toBe('100.00');
    expect(refund.status).toBe('PROCESSED');
    expect(refund.referenceTransaction?.id).toBe(bet.transactionId);
    expect(refundEntries).toHaveLength(1);
    expect(refundEntries[0]?.amount).toBe('30.00');
  });

  test('should return the same pending transaction for duplicate requests', async () => {
    const walletId = await createWallet();
    const referenceId = randomUUID();
    const externalId = randomUUID();

    const first = await createPendingRefund(walletId, referenceId, externalId);

    const second = await createPendingRefund(walletId, referenceId, externalId);

    expect(second).toEqual(first);

    const count = await orm.em.fork().count(WagerTransactionEntity, {
      providerId,
      externalTransactionId: externalId,
    });

    expect(count).toBe(1);
  });

  test('should prevent two workers from processing the same pending reversal', async () => {
    const walletId = await createWallet();
    const originalId = randomUUID();

    const pending = await createPendingRefund(walletId, originalId);

    await createOriginalBet(walletId, originalId);
    await makeRetryDue(pending.transactionId);

    const results = await Promise.all([
      repository().processNextPending(pending.transactionId),
      repository().processNextPending(pending.transactionId),
    ]);

    expect(results.sort()).toEqual(['EMPTY', 'PROCESSED']);

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const refunds = await em.count(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'REFUND',
    });

    expect(wallet.balance).toBe('100.00');
    expect(refunds).toBe(1);
  }, 30_000);

  test('should reject after the maximum retry attempts', async () => {
    const walletId = await createWallet();

    const pending = await createPendingRefund(walletId, randomUUID());

    for (let attempt = 1; attempt <= 5; attempt++) {
      await makeRetryDue(pending.transactionId);

      const result = await repository().processNextPending(pending.transactionId);

      expect(result).toBe(attempt === 5 ? 'REJECTED' : 'RETRIED');
    }

    const em = orm.em.fork();

    const transaction = await em.findOneOrFail(WagerTransactionEntity, {
      id: pending.transactionId,
    });

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    expect(transaction.status).toBe('REJECTED');
    expect(transaction.reason).toBe('REFERENCE_NOT_FOUND');
    expect(transaction.retryCount).toBe(5);
    expect(transaction.nextRetryAt).toBeNull();
    expect(wallet.balance).toBe('100.00');

    const nextResult = await repository().processNextPending(pending.transactionId);

    expect(nextResult).toBe('EMPTY');
  });

  test('should prevent modifying a terminal transaction', async () => {
    const walletId = await createWallet();

    const bet = await createOriginalBet(walletId, randomUUID());

    const em = orm.em.fork();

    await expect(
      em.getConnection().execute(
        `
      UPDATE public.wager_transactions
      SET
        status = 'PENDING_REFERENCE',
        next_retry_at = NOW()
      WHERE id = ?
      `,
        [bet.transactionId],
      ),
    ).rejects.toThrow('Terminal wagering transactions');
  });
});
