import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';

import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';

describe('Ledger immutability integration', () => {
  let orm: MikroORM;
  let walletId: string;
  let entryId: string;

  beforeAll(async () => {
    orm = await createTestOrm();

    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const wallet = await creator.execute({
      playerId: `immutable-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    walletId = wallet.id;

    const entry = await orm.em.fork().findOneOrFail(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'OPENING',
    });

    entryId = entry.id;
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('should allow creating new ledger entries', async () => {
    const entry = await orm.em.fork().findOneOrFail(WalletLedgerEntryEntity, { id: entryId });

    expect(entry.operation).toBe('OPENING');
    expect(entry.direction).toBe('CREDIT');
    expect(entry.amount).toBe('100.00');
  });

  test('should reject UPDATE on ledger', async () => {
    const em = orm.em.fork();

    await expect(
      em.getConnection().execute(
        `
        UPDATE wallet_ledger_entries
        SET amount = ?
        WHERE id = ?
        `,
        ['200.00', entryId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('should reject DELETE on ledger', async () => {
    const em = orm.em.fork();

    await expect(
      em.getConnection().execute(
        `
        DELETE FROM wallet_ledger_entries
        WHERE id = ?
        `,
        [entryId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('should reject TRUNCATE on ledger', async () => {
    const em = orm.em.fork();

    await expect(
      em.getConnection().execute('TRUNCATE TABLE wallet_ledger_entries'),
    ).rejects.toThrow(/permission denied/i);
  });

  test('should preserve original entry after rejected mutations', async () => {
    const em = orm.em.fork();

    const entry = await em.findOneOrFail(WalletLedgerEntryEntity, { id: entryId });

    expect(entry.wallet.id).toBe(walletId);
    expect(entry.amount).toBe('100.00');
    expect(entry.balanceBefore).toBe('0.00');
    expect(entry.balanceAfter).toBe('100.00');
  });
});
