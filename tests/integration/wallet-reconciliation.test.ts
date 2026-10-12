import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/wagering/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/reconciliation/reconcile-wallet.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';
import { PostgresReconciliationRepository } from '../../src/infrastructure/persistence/postgres-reconciliation.repository';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';

describe('Wallet reconciliation integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  function reconciler(): ReconcileWalletUseCase {
    return new ReconcileWalletUseCase(new PostgresReconciliationRepository(orm.em.fork()));
  }

  async function createWallet(): Promise<string> {
    const useCase = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const result = await useCase.execute({
      playerId: `test-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return result.id;
  }

  test('should reconcile a wallet after a bet', async () => {
    const walletId = await createWallet();

    const processor = new ProcessBetUseCase(new PostgresBetRepository(orm.em.fork()));

    await processor.execute({
      walletId,
      providerId: 'reconciliation-test',
      externalTransactionId: `bet-${randomUUID()}`,
      amount: '30.00',
      currency: 'BRL',
    });

    const report = await reconciler().execute(walletId);

    expect(report).not.toBeNull();
    expect(report?.storedBalance).toBe('70.00');
    expect(report?.ledgerBalance).toBe('70.00');
    expect(report?.difference).toBe('0.00');
    expect(report?.entryCount).toBe(2);
    expect(report?.consistent).toBe(true);
  });

  test('should detect a balance mismatch', async () => {
    const walletId = await createWallet();

    const em = orm.em.fork();

    // Simula uma alteração indevida no saldo.
    // Permitida apenas neste teste de diagnóstico.
    await em.nativeUpdate(WalletEntity, { id: walletId }, { balance: '95.00' });

    const report = await reconciler().execute(walletId);

    expect(report).not.toBeNull();
    expect(report?.storedBalance).toBe('95.00');
    expect(report?.ledgerBalance).toBe('100.00');
    expect(report?.difference).toBe('-5.00');
    expect(report?.consistent).toBe(false);
  });

  test('should return null for a nonexistent wallet', async () => {
    const report = await reconciler().execute(randomUUID());

    expect(report).toBeNull();
  });
});
