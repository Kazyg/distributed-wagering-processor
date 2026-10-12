import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { createTestOrm } from '../tests/integration/helpers/test-orm';

import { CreateWalletUseCase } from '../src/application/wallets/create-wallet.use-case';
import { PostgresWalletRepository } from '../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../src/infrastructure/persistence/postgres-bet.repository';
import { PostgresSqsInboxProcessor } from '../src/infrastructure/messaging/postgres-sqs-inbox.processor';
import { SqsInboxMessageEntity } from '../src/infrastructure/persistence/entities/sqs-inbox-message.entity';
import { WalletEntity } from '../src/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../src/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

async function createFifoQueue(sqs: SQSClient, name: string): Promise<string> {
  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '2',
        ReceiveMessageWaitTimeSeconds: '1',
        MessageRetentionPeriod: '3600',
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error(`Could not create ${name}`);
  }

  return result.QueueUrl;
}

async function receiveOne(
  sqs: SQSClient,
  queueUrl: string,
  visibilityTimeout = 2,
): Promise<Message | null> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );

  return result.Messages?.[0] ?? null;
}

async function receiveEventually(sqs: SQSClient, queueUrl: string): Promise<Message> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const message = await receiveOne(sqs, queueUrl);

    if (message) {
      return message;
    }
  }

  throw new Error('Expected SQS message was not delivered');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.DB_CONNECTION_MODE !== 'app') {
    throw new Error('Run this script in isolated test mode');
  }

  const sqs = createSqsClient();
  const queues: string[] = [];

  let orm: Awaited<ReturnType<typeof createTestOrm>> | undefined;

  try {
    orm = await createTestOrm();

    const suffix = randomUUID().slice(0, 8);
    const dlqUrl = await createFifoQueue(sqs, `wager-resilience-dlq-${suffix}.fifo`);
    queues.push(dlqUrl);

    const mainUrl = await createFifoQueue(sqs, `wager-resilience-${suffix}.fifo`);
    queues.push(mainUrl);

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const dlqArn = attributes.Attributes?.QueueArn;

    if (!dlqArn) {
      throw new Error('Missing test DLQ ARN');
    }

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: mainUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '3',
          }),
        },
      }),
    );

    const processor = new PostgresSqsInboxProcessor(
      orm.em.fork(),
      new PostgresBetRepository(orm.em.fork()),
    );
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const wallet = await creator.execute({
      playerId: `resilience-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    const messageId = randomUUID();

    const body = JSON.stringify({
      schemaVersion: 1,
      kind: 'WAGER_TRANSACTION',
      messageId,
      payload: {
        type: 'BET',
        walletId: wallet.id,
        providerId: 'resilience-test',
        externalTransactionId: randomUUID(),
        amount: '30.00',
        currency: 'BRL',
      },
    });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: mainUrl,
        MessageBody: body,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
      }),
    );

    const first = await receiveEventually(sqs, mainUrl);

    if (first.Body !== body) {
      throw new Error('Unexpected first message');
    }

    const firstResult = await processor.process(body);

    if (firstResult.outcome !== 'PROCESSED') {
      throw new Error('First message was not processed');
    }

    console.log('[resilience] Financial commit succeeded');
    console.log('[resilience] Simulated crash before ACK');

    await Bun.sleep(2300);

    const second = await receiveEventually(sqs, mainUrl);

    if (second.Body !== body || !second.ReceiptHandle) {
      throw new Error('Expected redelivery of original message');
    }

    const secondResult = await processor.process(second.Body);

    if (secondResult.outcome !== 'DUPLICATE') {
      throw new Error('Redelivery caused incorrect processing');
    }

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: mainUrl,
        ReceiptHandle: second.ReceiptHandle,
      }),
    );

    const em = orm.em.fork();

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: wallet.id });

    const debitCount = await em.count(WalletLedgerEntryEntity, {
      wallet: wallet.id,
      operation: 'BET',
    });

    const inboxCount = await em.count(SqsInboxMessageEntity, { id: messageId });

    if (storedWallet.balance !== '70.00' || debitCount !== 1 || inboxCount !== 1) {
      throw new Error('Duplicate processing changed financial state');
    }

    console.log('[resilience] Redelivery safely deduplicated');
    console.log('[resilience] Balance: 70.00, BET entries: 1');
    const invalidBody = '{"schemaVersion":1,"kind":';

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: mainUrl,
        MessageBody: invalidBody,
        MessageGroupId: `invalid-${randomUUID()}`,
        MessageDeduplicationId: randomUUID(),
      }),
    );

    let failedReceives = 0;

    for (let attempt = 0; attempt < 10; attempt++) {
      const message = await receiveOne(sqs, mainUrl, 0);

      if (!message) {
        continue;
      }

      if (message.Body !== invalidBody) {
        throw new Error('Unexpected message in isolated test queue');
      }

      let rejected = false;

      try {
        await processor.process(message.Body);
      } catch {
        rejected = true;
      }

      if (!rejected) {
        throw new Error('Malformed message was accepted');
      }

      failedReceives += 1;

      console.log('[resilience] Invalid message rejected', {
        receiveCount: message.Attributes?.ApproximateReceiveCount,
      });
      await Bun.sleep(150);
    }

    let deadLetter: Message | null = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      deadLetter = await receiveOne(sqs, dlqUrl);

      if (deadLetter) {
        break;
      }
    }

    if (deadLetter?.Body !== invalidBody) {
      throw new Error('Invalid message did not reach the DLQ');
    }

    console.log('[resilience] DLQ received invalid message', {
      failedReceives,
      sqsMessageId: deadLetter.MessageId,
    });

    if (deadLetter.ReceiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: dlqUrl,
          ReceiptHandle: deadLetter.ReceiptHandle,
        }),
      );
    }

    console.log('[resilience] All checks passed');
  } finally {
    if (orm) {
      await orm.close(true);
    }
    for (const queueUrl of queues.reverse()) {
      try {
        await sqs.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        );
      } catch (error) {
        console.error('Temporary queue cleanup failed:', error);
      }
    }

    sqs.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
