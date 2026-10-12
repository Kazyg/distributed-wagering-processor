import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/wagering/process-bet.use-case';
import { ProcessOutcomeUseCase } from '../../src/application/wagering/process-outcome.use-case';

import {
  ProcessReversalUseCase,
  ReferenceAlreadyReversedError,
} from '../../src/application/wagering/process-reversal.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities/wager-transaction.entity';

describe('REFUND and ROLLBACK integration', () => {
  let orm: MikroORM;

  const providerId = 'reversal-test-provider';

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  function repository(): PostgresBetRepository {
    return new PostgresBetRepository(orm.em.fork());
  }

  async function createWallet(): Promise<string> {
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const result = await creator.execute({
      playerId: `reversal-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return result.id;
  }

  async function bet(walletId: string, amount: string, externalTransactionId: string) {
    return new ProcessBetUseCase(repository()).execute({
      walletId,
      providerId,
      externalTransactionId,
      amount,
      currency: 'BRL',
    });
  }

  async function outcome(
    walletId: string,
    type: 'WIN' | 'LOSS',
    amount: string,
    externalTransactionId: string,
  ) {
    return new ProcessOutcomeUseCase(repository()).execute({
      walletId,
      providerId,
      externalTransactionId,
      type,
      amount,
      currency: 'BRL',
    });
  }

  function reversal(
    walletId: string,
    type: 'REFUND' | 'ROLLBACK',
    referenceExternalTransactionId: string,
    amount: string,
    externalTransactionId = randomUUID(),
  ) {
    return new ProcessReversalUseCase(repository()).execute({
      walletId,
      providerId,
      externalTransactionId,
      referenceExternalTransactionId,
      type,
      amount,
      currency: 'BRL',
    });
  }

  test('should refund a processed BET only once', async () => {
    const walletId = await createWallet();
    const originalId = randomUUID();
    const refundId = randomUUID();

    await bet(walletId, '30.00', originalId);

    const first = await reversal(walletId, 'REFUND', originalId, '30.00', refundId);

    const replay = await reversal(walletId, 'REFUND', originalId, '30.00', refundId);

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const refunds = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'REFUND',
    });

    expect(first.status).toBe('PROCESSED');
    expect(replay).toEqual(first);
    expect(wallet.balance).toBe('100.00');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.direction).toBe('CREDIT');
    expect(refunds[0]?.amount).toBe('30.00');
  });

  test('should rollback a BET with a credit', async () => {
    const walletId = await createWallet();
    const originalId = randomUUID();

    await bet(walletId, '20.00', originalId);

    const result = await reversal(walletId, 'ROLLBACK', originalId, '20.00');

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const entries = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'ROLLBACK',
    });

    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('100.00');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe('CREDIT');
  });

  test('should rollback WIN by debiting its credit', async () => {
    const walletId = await createWallet();
    const originalId = randomUUID();

    await outcome(walletId, 'WIN', '50.00', originalId);

    const result = await reversal(walletId, 'ROLLBACK', originalId, '50.00');

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const entries = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'ROLLBACK',
    });

    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('100.00');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe('DEBIT');
  });

  test('should reject WIN rollback without funds', async () => {
    const walletId = await createWallet();
    const winId = randomUUID();

    await outcome(walletId, 'WIN', '50.00', winId);
    await bet(walletId, '140.00', randomUUID());

    const result = await reversal(walletId, 'ROLLBACK', winId, '50.00');

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const rollbackEntries = await em.count(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'ROLLBACK',
    });

    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('INSUFFICIENT_FUNDS');
    expect(wallet.balance).toBe('10.00');
    expect(rollbackEntries).toBe(0);
  });

  test('should prevent concurrent reversals of one BET', async () => {
    const walletId = await createWallet();
    const originalId = randomUUID();

    await bet(walletId, '30.00', originalId);

    const results = await Promise.allSettled([
      reversal(walletId, 'REFUND', originalId, '30.00'),
      reversal(walletId, 'ROLLBACK', originalId, '30.00'),
    ]);

    const successful = results.filter((result) => result.status === 'fulfilled');

    const rejected = results.filter((result) => result.status === 'rejected');

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0];

    if (failure?.status !== 'rejected') {
      throw new Error('Expected one rejected reversal');
    }

    expect(failure.reason).toBeInstanceOf(ReferenceAlreadyReversedError);

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const processedReversals = await em.count(WagerTransactionEntity, {
      wallet: walletId,
      type: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });

    expect(wallet.balance).toBe('100.00');
    expect(processedReversals).toBe(1);
  }, 30_000);

  test('should persist a missing reference as pending', async () => {
    const walletId = await createWallet();
    const externalId = randomUUID();
    const referenceExternalId = randomUUID();

    const result = await reversal(walletId, 'REFUND', referenceExternalId, '20.00', externalId);

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(result.balanceAfter).toBe('100.00');
    expect(result.reason).toBeNull();

    const em = orm.em.fork();

    const transaction = await em.findOneOrFail(WagerTransactionEntity, {
      providerId,
      externalTransactionId: externalId,
    });

    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.referenceExternalTransactionId).toBe(referenceExternalId);
    expect(transaction.referenceTransaction).toBeNull();
    expect(transaction.retryCount).toBe(0);
    expect(transaction.nextRetryAt).not.toBeNull();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    expect(wallet.balance).toBe('100.00');

    const entries = await em.find(WalletLedgerEntryEntity, { wallet: walletId });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.operation).toBe('OPENING');
  });

  test('should rollback LOSS without ledger movement', async () => {
    const walletId = await createWallet();
    const lossId = randomUUID();

    await bet(walletId, '30.00', randomUUID());
    await outcome(walletId, 'LOSS', '30.00', lossId);

    const result = await reversal(walletId, 'ROLLBACK', lossId, '30.00');

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const rollbackEntries = await em.count(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'ROLLBACK',
    });

    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('70.00');
    expect(rollbackEntries).toBe(0);
  });
});
