import 'reflect-metadata';

import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

import { PostgresOutboxRepository } from '../src/infrastructure/persistence/postgres-outbox.repository';

import { SqsOutboxPublisher } from '../src/infrastructure/messaging/sqs-outbox.publisher';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';

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
    const { results } = getSqsQueueNames();

    const queue = await sqs.send(
      new GetQueueUrlCommand({
        QueueName: results,
      }),
    );

    if (!queue.QueueUrl) {
      throw new Error('Results queue not found');
    }

    const publisher = new SqsOutboxPublisher(
      new PostgresOutboxRepository(orm.em.fork()),
      sqs,
      queue.QueueUrl,
    );

    console.log('[outbox-publisher] Started');

    while (!stopping) {
      try {
        const result = await publisher.publishNext();

        if (result !== 'EMPTY') {
          console.log(`[outbox-publisher] Result: ${result}`);
        }

        if (result !== 'PUBLISHED') {
          await Bun.sleep(1_000);
        }
      } catch (error: unknown) {
        console.error('[outbox-publisher] Worker failure:', error);

        await Bun.sleep(1_000);
      }
    }
  } finally {
    sqs.destroy();
    await orm.close(true);

    console.log('[outbox-publisher] Stopped');
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
