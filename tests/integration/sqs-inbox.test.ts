import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';

import { WalletNotFoundError } from '../../src/application/wagering/process-bet.use-case';

import { type WagerQueueMessage } from '../../src/application/wagering/wager-queue-message';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';

import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

import {
  InboxPayloadConflictError,
  PostgresSqsInboxProcessor,
} from '../../src/infrastructure/messaging/postgres-sqs-inbox.processor';

import { SqsInboxMessageEntity } from '../../src/infrastructure/persistence/entities/sqs-inbox-message.entity';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity';

import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';

import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities/wager-transaction.entity';

describe('Transactional SQS Inbox', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  function processor(): PostgresSqsInboxProcessor {
    return new PostgresSqsInboxProcessor(orm.em.fork(), new PostgresBetRepository(orm.em.fork()));
  }

  async function createWallet(): Promise<string> {
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const wallet = await creator.execute({
      playerId: `sqs-inbox-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return wallet.id;
  }

  function message(walletId: string): WagerQueueMessage {
    return {
      schemaVersion: 1,
      kind: 'WAGER_TRANSACTION',
      messageId: randomUUID(),
      payload: {
        type: 'BET',
        walletId,
        providerId: 'sqs-inbox-tests',
        externalTransactionId: randomUUID(),
        amount: '30.00',
        currency: 'BRL',
      },
    };
  }

  test('should commit Inbox and financial transaction together', async () => {
    const walletId = await createWallet();
    const event = message(walletId);

    const result = await processor().process(JSON.stringify(event));

    expect(result.outcome).toBe('PROCESSED');

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });

    const inboxCount = await em.count(SqsInboxMessageEntity, { id: event.messageId });

    const wagers = await em.find(WagerTransactionEntity, {
      providerId: event.payload.providerId,
      externalTransactionId: event.payload.externalTransactionId,
    });

    const debits = await em.find(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'BET',
    });

    expect(wallet.balance).toBe('70.00');
    expect(inboxCount).toBe(1);
    expect(wagers).toHaveLength(1);
    expect(debits).toHaveLength(1);
  });

  test('should ignore an already processed message', async () => {
    const walletId = await createWallet();
    const body = JSON.stringify(message(walletId));

    const first = await processor().process(body);
    const second = await processor().process(body);

    expect(first.outcome).toBe('PROCESSED');
    expect(second.outcome).toBe('DUPLICATE');

    const wallet = await orm.em.fork().findOneOrFail(WalletEntity, { id: walletId });

    const debits = await orm.em.fork().count(WalletLedgerEntryEntity, {
      wallet: walletId,
      operation: 'BET',
    });

    expect(wallet.balance).toBe('70.00');
    expect(debits).toBe(1);
  });

  test('should prevent concurrent duplicate processing', async () => {
    const walletId = await createWallet();
    const body = JSON.stringify(message(walletId));

    const results = await Promise.all(Array.from({ length: 10 }, () => processor().process(body)));

    expect(results.filter((result) => result.outcome === 'PROCESSED')).toHaveLength(1);

    expect(results.filter((result) => result.outcome === 'DUPLICATE')).toHaveLength(9);

    const wallet = await orm.em.fork().findOneOrFail(WalletEntity, { id: walletId });

    expect(wallet.balance).toBe('70.00');
  }, 30_000);

  test('should rollback Inbox when the wallet does not exist', async () => {
    const event = message(randomUUID());

    await expect(processor().process(JSON.stringify(event))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );

    const inboxCount = await orm.em.fork().count(SqsInboxMessageEntity, { id: event.messageId });

    const wagerCount = await orm.em.fork().count(WagerTransactionEntity, {
      providerId: event.payload.providerId,
      externalTransactionId: event.payload.externalTransactionId,
    });

    expect(inboxCount).toBe(0);
    expect(wagerCount).toBe(0);
  });

  test('should reject conflicting contents for the same message ID', async () => {
    const walletId = await createWallet();
    const event = message(walletId);

    await processor().process(JSON.stringify(event));

    const changed: WagerQueueMessage = {
      ...event,
      payload: {
        ...event.payload,
        amount: '40.00',
      },
    };

    await expect(processor().process(JSON.stringify(changed))).rejects.toBeInstanceOf(
      InboxPayloadConflictError,
    );

    const wallet = await orm.em.fork().findOneOrFail(WalletEntity, { id: walletId });

    expect(wallet.balance).toBe('70.00');
  });
});
