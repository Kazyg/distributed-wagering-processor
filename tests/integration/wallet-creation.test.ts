import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { WalletAlreadyExistsError } from '../../src/application/wallets/wallet-already-exists.error';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';

describe('Wallet persistence integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('should persist wallet and opening ledger in PostgreSQL', async () => {
    const repository = new PostgresWalletRepository(orm.em.fork());
    const useCase = new CreateWalletUseCase(repository);

    const playerId = `test-${randomUUID()}`;

    const result = await useCase.execute({
      playerId,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, {
      id: result.id,
    });

    const entries = await em.find(WalletLedgerEntryEntity, {
      wallet: result.id,
    });

    expect(wallet.balance).toBe('100.00');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.operation).toBe('OPENING');
    expect(entries[0]?.amount).toBe('100.00');

    await expect(
      useCase.execute({
        playerId,
        currency: 'BRL',
        openingBalance: '100.00',
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    const walletCount = await orm.em.fork().count(WalletEntity, {
      playerId,
      currency: 'BRL',
    });

    expect(walletCount).toBe(1);
  });
});
