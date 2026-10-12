import 'reflect-metadata';

import { GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

import { PostgresBetRepository } from '../src/infrastructure/persistence/postgres-bet.repository';

import { PostgresSqsInboxProcessor } from '../src/infrastructure/messaging/postgres-sqs-inbox.processor';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';

import { handleWagerSqsMessage } from '../src/infrastructure/messaging/sqs-wager-message-handler';

const VISIBILITY_TIMEOUT_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 20_000;

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  const sqs = createSqsClient();

  let stopping = false;

  process.once('SIGINT', () => {
    stopping = true;
  });

  process.once('SIGTERM', () => {
    stopping = true;
  });

  try {
    const { main: queueName } = getSqsQueueNames();

    const queue = await sqs.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      }),
    );

    if (!queue.QueueUrl) {
      throw new Error('Wager queue not found');
    }

    const queueUrl = queue.QueueUrl;

    const processor = new PostgresSqsInboxProcessor(
      orm.em.fork(),
      new PostgresBetRepository(orm.em.fork()),
    );

    console.log('[sqs-consumer] Started');

    while (!stopping) {
      try {
        const received = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 10,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );

        for (const message of received.Messages ?? []) {
          try {
            const handled = await handleWagerSqsMessage(sqs, queueUrl, message, processor, {
              visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
              heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            });

            console.log('[sqs-consumer] ACK', {
              sqsMessageId: message.MessageId,
              receiveCount: message.Attributes?.ApproximateReceiveCount,
              ...handled,
            });
          } catch (error: unknown) {
            console.error('[sqs-consumer] Processing failed', {
              sqsMessageId: message.MessageId,
              receiveCount: message.Attributes?.ApproximateReceiveCount,
              error,
            });
          }
        }
      } catch (error: unknown) {
        console.error('[sqs-consumer] Polling failed:', error);

        await Bun.sleep(1_000);
      }
    }
  } finally {
    sqs.destroy();
    await orm.close(true);

    console.log('[sqs-consumer] Stopped');
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
