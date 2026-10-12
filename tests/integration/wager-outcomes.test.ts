import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';

import {
  IdempotencyConflictError,
  ProcessBetUseCase,
} from '../../src/application/wagering/process-bet.use-case';

import {
  ProcessOutcomeUseCase,
  type ProcessOutcomeInput,
} from '../../src/application/wagering/process-outcome.use-case';

import { ReconcileWalletUseCase } from '../../src/application/reconciliation/reconcile-wallet.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';

import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

import { PostgresReconciliationRepository } from '../../src/infrastructure/persistence/postgres-reconciliation.repository';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';

import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';

import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities/wager-transaction.entity';

describe('WIN and LOSS integration', () => {
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
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const wallet = await creator.execute({
      playerId: `outcome-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return wallet.id;
  }

  function betProcessor(): ProcessBetUseCase {
    return new ProcessBetUseCase(new PostgresBetRepository(orm.em.fork()));
  }

  function outcomeProcessor(): ProcessOutcomeUseCase {
    return new ProcessOutcomeUseCase(new PostgresBetRepository(orm.em.fork()));
  }

  function outcome(
    walletId: string,
    type: 'WIN' | 'LOSS',
    amount: string,
    externalId = randomUUID(),
  ): ProcessOutcomeInput {
    return {
      type,
      walletId,
      providerId: 'outcome-provider',
      externalTransactionId: externalId,
      amount,
      currency: 'BRL',
    };
  }

  async function placeBet(walletId: string, amount: string): Promise<void> {
    const result = await betProcessor().execute({
      walletId,
      providerId: 'outcome-provider',
      externalTransactionId: randomUUID(),
      amount,
      currency: 'BRL',
    });

    expect(result.status).toBe('PROCESSED');
  }

  test('should credit WIN and create a ledger entry', async () => {
    const walletId = await createWallet();

    await placeBet(walletId, '30.00');

    const result = await outcomeProcessor().execute(outcome(walletId, 'WIN', '50.00'));

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const wins = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'WIN',
    });

    expect(result.status).toBe('PROCESSED');
    expect(result.balanceAfter).toBe('120.00');
    expect(wallet.balance).toBe('120.00');

    expect(wins).toHaveLength(1);
    expect(wins[0]?.direction).toBe('CREDIT');
    expect(wins[0]?.amount).toBe('50.00');
    expect(wins[0]?.balanceBefore).toBe('70.00');
    expect(wins[0]?.balanceAfter).toBe('120.00');

    const reconciler = new ReconcileWalletUseCase(
      new PostgresReconciliationRepository(orm.em.fork()),
    );

    const report = await reconciler.execute(walletId);

    expect(report?.consistent).toBe(true);
    expect(report?.ledgerBalance).toBe('120.00');
    expect(report?.entryCount).toBe(3);
  });

  test('should record LOSS without changing balance', async () => {
    const walletId = await createWallet();

    await placeBet(walletId, '30.00');

    const request = outcome(walletId, 'LOSS', '30.00');

    const first = await outcomeProcessor().execute(request);
    const replay = await outcomeProcessor().execute(request);

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const transactions = await em.find(WagerTransactionEntity, {
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
    });

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, { wallet: walletId });

    expect(first.status).toBe('PROCESSED');
    expect(first.balanceAfter).toBe('70.00');
    expect(replay).toEqual(first);

    expect(wallet.balance).toBe('70.00');

    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.type).toBe('LOSS');

    expect(ledgerEntries).toHaveLength(2);
  });

  test('should process duplicate WIN only once', async () => {
    const walletId = await createWallet();

    const request = outcome(walletId, 'WIN', '25.00');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => outcomeProcessor().execute(request)),
    );

    const first = results[0];

    if (!first) {
      throw new Error('Expected at least one transaction result');
    }

    for (const result of results) {
      expect(result).toEqual(first);
    }

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const wins = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'WIN',
    });

    expect(wallet.balance).toBe('125.00');
    expect(wins).toHaveLength(1);
  }, 30_000);

  test('should reject idempotency conflicts between BET and WIN', async () => {
    const walletId = await createWallet();
    const externalId = randomUUID();

    await betProcessor().execute({
      walletId,
      providerId: 'outcome-provider',
      externalTransactionId: externalId,
      amount: '10.00',
      currency: 'BRL',
    });

    await expect(
      outcomeProcessor().execute(outcome(walletId, 'WIN', '10.00', externalId)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    expect(wallet.balance).toBe('90.00');

    const wins = await em.count(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'WIN',
    });

    expect(wins).toBe(0);
  });

  test('should process concurrent different WIN transactions', async () => {
    const walletId = await createWallet();

    const results = await Promise.all([
      outcomeProcessor().execute(outcome(walletId, 'WIN', '25.00')),
      outcomeProcessor().execute(outcome(walletId, 'WIN', '40.00')),
    ]);

    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const wins = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'WIN',
    });

    expect(wallet.balance).toBe('165.00');
    expect(wins).toHaveLength(2);

    const reconciler = new ReconcileWalletUseCase(
      new PostgresReconciliationRepository(orm.em.fork()),
    );

    const report = await reconciler.execute(walletId);

    expect(report?.consistent).toBe(true);
    expect(report?.ledgerBalance).toBe('165.00');
  }, 30_000);
});
