import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { createTestOrm } from '../tests/integration/helpers/test-orm';

import { CreateWalletUseCase } from '../src/application/wallets/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../src/application/reconciliation/reconcile-wallet.use-case';

import type { WagerQueueMessage } from '../src/application/wagering/wager-queue-message';
import type { WagerResultEvent } from '../src/application/wagering/wager-result-event';

import { PostgresWalletRepository } from '../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../src/infrastructure/persistence/postgres-bet.repository';
import { PostgresReconciliationRepository } from '../src/infrastructure/persistence/postgres-reconciliation.repository';
import { PostgresOutboxRepository } from '../src/infrastructure/persistence/postgres-outbox.repository';

import { WalletEntity } from '../src/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../src/infrastructure/persistence/entities/wager-transaction.entity';
import { SqsInboxMessageEntity } from '../src/infrastructure/persistence/entities/sqs-inbox-message.entity';
import { WagerOutboxEventEntity } from '../src/infrastructure/persistence/entities/wager-outbox-event.entity';

import { PostgresSqsInboxProcessor } from '../src/infrastructure/messaging/postgres-sqs-inbox.processor';
import { SqsOutboxPublisher } from '../src/infrastructure/messaging/sqs-outbox.publisher';
import { handleWagerSqsMessage } from '../src/infrastructure/messaging/sqs-wager-message-handler';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

function assertSafeEnvironment(): void {
  if (process.env.NODE_ENV !== 'test' || process.env.DB_CONNECTION_MODE !== 'app') {
    throw new Error('E2E must run in test mode');
  }

  const endpoint = process.env.SQS_ENDPOINT;

  if (!endpoint) {
    throw new Error('LocalStack endpoint is required');
  }

  const url = new URL(endpoint);

  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '4566'
  ) {
    throw new Error('E2E only supports local LocalStack');
  }
}

async function createTemporaryQueue(sqs: SQSClient, name: string): Promise<string> {
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '10',
        ReceiveMessageWaitTimeSeconds: '1',
        MessageRetentionPeriod: '3600',
      },
    }),
  );

  if (!created.QueueUrl) {
    throw new Error(`Could not create SQS queue: ${name}`);
  }

  return created.QueueUrl;
}

async function receiveRequired(sqs: SQSClient, queueUrl: string): Promise<Message> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const message = response.Messages?.[0];

    if (message) {
      return message;
    }
  }

  throw new Error('Expected SQS message was not delivered');
}

async function main(): Promise<void> {
  assertSafeEnvironment();

  const orm = await createTestOrm();
  const sqs = createSqsClient();

  const temporaryQueues: string[] = [];

  try {
    const connection = await orm.em.fork().execute<{
      databaseName: string;
      username: string;
    }>(
      `
      SELECT
        current_database() AS "databaseName",
        current_user AS "username"
      `,
      [],
      'get',
    );

    assert.equal(connection.databaseName, 'wagering_test');
    assert.equal(connection.username, process.env.POSTGRES_APP_USER);

    const suffix = randomUUID().slice(0, 8);

    const inputUrl = await createTemporaryQueue(sqs, `wager-e2e-input-${suffix}.fifo`);
    temporaryQueues.push(inputUrl);

    const resultsUrl = await createTemporaryQueue(sqs, `wager-e2e-results-${suffix}.fifo`);
    temporaryQueues.push(resultsUrl);

    console.log('[e2e] Temporary FIFO queues created');
    const wallet = await new CreateWalletUseCase(
      new PostgresWalletRepository(orm.em.fork()),
    ).execute({
      playerId: `e2e-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    assert.equal(wallet.balance, '100.00');
    const incoming: WagerQueueMessage = {
      schemaVersion: 1,
      kind: 'WAGER_TRANSACTION',
      messageId: randomUUID(),
      payload: {
        type: 'BET',
        walletId: wallet.id,
        providerId: 'distributed-e2e',
        externalTransactionId: randomUUID(),
        amount: '30.00',
        currency: 'BRL',
      },
    };

    const body = JSON.stringify(incoming);
    for (let i = 0; i < 2; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: inputUrl,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
    }

    console.log('[e2e] Two input messages sent');

    const processor = new PostgresSqsInboxProcessor(
      orm.em.fork(),
      new PostgresBetRepository(orm.em.fork()),
    );
    const firstMessage = await receiveRequired(sqs, inputUrl);

    const first = await handleWagerSqsMessage(sqs, inputUrl, firstMessage, processor, {
      visibilityTimeoutSeconds: 10,
      heartbeatIntervalMs: 2_000,
    });

    assert.equal(first.result.outcome, 'PROCESSED');

    console.log('[e2e] First delivery processed and ACKed');
    const secondMessage = await receiveRequired(sqs, inputUrl);

    const second = await handleWagerSqsMessage(sqs, inputUrl, secondMessage, processor, {
      visibilityTimeoutSeconds: 10,
      heartbeatIntervalMs: 2_000,
    });

    assert.equal(second.result.outcome, 'DUPLICATE');

    console.log('[e2e] Duplicate safely ACKed');
    const em = orm.em.fork();

    const savedWallet = await em.findOneOrFail(WalletEntity, { id: wallet.id });

    const inboxCount = await em.count(SqsInboxMessageEntity, { id: incoming.messageId });

    const wagers = await em.find(WagerTransactionEntity, {
      providerId: incoming.payload.providerId,
      externalTransactionId: incoming.payload.externalTransactionId,
    });

    const betLedgerCount = await em.count(WalletLedgerEntryEntity, {
      wallet: wallet.id,
      operation: 'BET',
    });

    assert.equal(savedWallet.balance, '70.00');
    assert.equal(inboxCount, 1);
    assert.equal(wagers.length, 1);
    assert.equal(betLedgerCount, 1);

    const transaction = wagers[0];

    if (!transaction) {
      throw new Error('Financial transaction was not persisted');
    }

    const outboxEvents = await em.find(WagerOutboxEventEntity, { wager: transaction.id });

    assert.equal(outboxEvents.length, 1);

    const outboxEvent = outboxEvents[0];

    if (!outboxEvent) {
      throw new Error('Outbox event was not created');
    }

    assert.equal(outboxEvent.publishedAt, null);

    console.log('[e2e] Inbox, Wallet, Ledger and Outbox verified');
    const publisher = new SqsOutboxPublisher(
      new PostgresOutboxRepository(orm.em.fork()),
      sqs,
      resultsUrl,
    );

    const published = await publisher.publishNext(outboxEvent.eventId);

    assert.equal(published, 'PUBLISHED');

    console.log('[e2e] Outbox event published');
    const resultMessage = await receiveRequired(sqs, resultsUrl);

    if (!resultMessage.Body || !resultMessage.ReceiptHandle) {
      throw new Error('Invalid results message');
    }

    const resultEvent = JSON.parse(resultMessage.Body) as WagerResultEvent;

    assert.equal(resultEvent.kind, 'WAGER_TRANSACTION_FINALIZED');
    assert.equal(resultEvent.type, 'BET');
    assert.equal(resultEvent.status, 'PROCESSED');
    assert.equal(resultEvent.amount, '30.00');
    assert.equal(resultEvent.balanceAfter, '70.00');
    assert.equal(resultEvent.walletId, wallet.id);
    assert.equal(resultEvent.transactionId, transaction.id);
    assert.equal(resultEvent.eventId, outboxEvent.eventId);

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: resultsUrl,
        ReceiptHandle: resultMessage.ReceiptHandle,
      }),
    );

    console.log('[e2e] Financial result received and ACKed');
    const publishedEvent = await orm.em
      .fork()
      .findOneOrFail(WagerOutboxEventEntity, { eventId: outboxEvent.eventId });

    assert.notEqual(publishedEvent.publishedAt, null);
    assert.equal(publishedEvent.attemptCount, 1);
    const repeatedPublication = await publisher.publishNext(outboxEvent.eventId);

    assert.equal(repeatedPublication, 'EMPTY');
    const reconciliation = await new ReconcileWalletUseCase(
      new PostgresReconciliationRepository(orm.em.fork()),
    ).execute(wallet.id);

    assert.ok(reconciliation);
    assert.equal(reconciliation.consistent, true);
    assert.equal(reconciliation.storedBalance, '70.00');
    assert.equal(reconciliation.ledgerBalance, '70.00');
    assert.equal(reconciliation.difference, '0.00');
    assert.equal(reconciliation.entryCount, 2);

    console.log('[e2e] Financial reconciliation consistent');
    console.log('[e2e] All distributed checks passed');
  } finally {
    await orm.close(true);
    for (const queueUrl of temporaryQueues.reverse()) {
      try {
        await sqs.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        );
      } catch (error) {
        console.error('[e2e] Temporary queue cleanup failed', error);
      }
    }

    sqs.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
