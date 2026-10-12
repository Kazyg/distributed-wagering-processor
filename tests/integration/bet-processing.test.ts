import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import {
  IdempotencyConflictError,
  ProcessBetUseCase,
  type ProcessBetInput,
} from '../../src/application/wagering/process-bet.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities/wager-transaction.entity';

describe('Bet processing integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  function processor(): ProcessBetUseCase {
    return new ProcessBetUseCase(new PostgresBetRepository(orm.em.fork()));
  }

  async function withWallet(run: (walletId: string) => Promise<void>): Promise<void> {
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const wallet = await creator.execute({
      playerId: `test-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    await run(wallet.id);
  }

  function bet(walletId: string, externalTransactionId: string, amount: string): ProcessBetInput {
    return {
      walletId,
      providerId: 'integration-provider',
      externalTransactionId,
      amount,
      currency: 'BRL',
    };
  }

  test('should prevent the same idempotency key across wallets', async () => {
    await withWallet(async (firstWalletId) => {
      await withWallet(async (secondWalletId) => {
        const externalId = `shared-${randomUUID()}`;

        const results = await Promise.allSettled([
          processor().execute(bet(firstWalletId, externalId, '10.00')),
          processor().execute(bet(secondWalletId, externalId, '10.00')),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');

        const rejected = results.filter((result) => result.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const rejection = rejected[0];

        if (!rejection) {
          throw new Error('Expected one rejected request');
        }

        expect(rejection.reason).toBeInstanceOf(IdempotencyConflictError);

        const em = orm.em.fork();

        const wallets = await Promise.all([
          em.findOneOrFail(WalletEntity, { id: firstWalletId }),
          em.findOneOrFail(WalletEntity, { id: secondWalletId }),
        ]);

        const balances = wallets.map((wallet) => wallet.balance).sort();

        expect(balances).toEqual(['100.00', '90.00'].sort());

        const transactionCount = await em.count(WagerTransactionEntity, {
          providerId: 'integration-provider',
          externalTransactionId: externalId,
        });

        expect(transactionCount).toBe(1);
      });
    });
  }, 30_000);

  test('should prevent overspending across 50 different bets', async () => {
    await withWallet(async (walletId) => {
      const requests = Array.from({ length: 50 }, () =>
        bet(walletId, `stress-${randomUUID()}`, '3.00'),
      );

      const results = await Promise.all(requests.map((request) => processor().execute(request)));

      const processed = results.filter((result) => result.status === 'PROCESSED');

      const rejected = results.filter((result) => result.status === 'REJECTED');

      expect(results).toHaveLength(50);
      expect(processed).toHaveLength(33);
      expect(rejected).toHaveLength(17);

      expect(rejected.every((result) => result.reason === 'INSUFFICIENT_FUNDS')).toBe(true);

      const em = orm.em.fork();

      const wallet = await em.findOneOrFail(WalletEntity, {
        id: walletId,
      });

      const debits = await em.find(WalletLedgerEntryEntity, {
        wallet: walletId,
        operation: 'BET',
      });

      const transactions = await em.find(WagerTransactionEntity, {
        wallet: walletId,
      });

      expect(wallet.balance).toBe('1.00');
      expect(debits).toHaveLength(33);
      expect(transactions).toHaveLength(50);

      expect(debits.every((entry) => entry.amount === '3.00')).toBe(true);
    });
  }, 30_000);

  test('should prevent concurrent overspending', async () => {
    await withWallet(async (walletId) => {
      const requests = [
        bet(walletId, `bet-${randomUUID()}`, '80.00'),
        bet(walletId, `bet-${randomUUID()}`, '80.00'),
      ];

      const results = await Promise.all(requests.map((request) => processor().execute(request)));

      expect(results.map((result) => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);

      const em = orm.em.fork();

      const wallet = await em.findOneOrFail(WalletEntity, {
        id: walletId,
      });

      const debits = await em.find(WalletLedgerEntryEntity, {
        wallet: walletId,
        operation: 'BET',
      });

      const transactions = await em.find(WagerTransactionEntity, {
        wallet: walletId,
      });

      expect(wallet.balance).toBe('20.00');
      expect(debits).toHaveLength(1);
      expect(transactions).toHaveLength(2);
    });
  });

  test('should process the same bet only once', async () => {
    await withWallet(async (walletId) => {
      const request = bet(walletId, `duplicate-${randomUUID()}`, '30.00');

      const results = await Promise.all(
        Array.from({ length: 50 }, () => processor().execute(request)),
      );

      expect(results).toHaveLength(50);

      const first = results[0];

      if (!first) {
        throw new Error('Expected at least one bet result');
      }

      for (const result of results) {
        expect(result).toEqual(first);
      }

      const em = orm.em.fork();

      const wallet = await em.findOneOrFail(WalletEntity, {
        id: walletId,
      });

      const debits = await em.find(WalletLedgerEntryEntity, {
        wallet: walletId,
        operation: 'BET',
      });

      const transactions = await em.find(WagerTransactionEntity, {
        wallet: walletId,
      });

      expect(wallet.balance).toBe('70.00');
      expect(debits).toHaveLength(1);
      expect(transactions).toHaveLength(1);
    });
  });

  test('should detect idempotency payload conflicts', async () => {
    await withWallet(async (walletId) => {
      const externalId = `conflict-${randomUUID()}`;

      await processor().execute(bet(walletId, externalId, '30.00'));

      await expect(processor().execute(bet(walletId, externalId, '40.00'))).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });
  });

  test('should persist insufficient-funds rejection', async () => {
    await withWallet(async (walletId) => {
      const request = bet(walletId, `insufficient-${randomUUID()}`, '150.00');

      const first = await processor().execute(request);
      const replay = await processor().execute(request);

      expect(first.status).toBe('REJECTED');
      expect(first.reason).toBe('INSUFFICIENT_FUNDS');
      expect(replay).toEqual(first);

      const em = orm.em.fork();

      const wallet = await em.findOneOrFail(WalletEntity, {
        id: walletId,
      });

      const debits = await em.find(WalletLedgerEntryEntity, {
        wallet: walletId,
        operation: 'BET',
      });

      expect(wallet.balance).toBe('100.00');
      expect(debits).toHaveLength(0);
    });
  });
});
