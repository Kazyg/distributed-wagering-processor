import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';

import { wagerQueueMessageSchema } from '../src/application/wagering/wager-queue-message';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';

async function main(): Promise<void> {
  const [walletId, amount, option] = process.argv.slice(2);

  if (!walletId || !amount) {
    throw new Error('Usage: bun run sqs:send-demo <walletId> <amount> [--duplicate]');
  }

  const event = wagerQueueMessageSchema.parse({
    schemaVersion: 1,
    kind: 'WAGER_TRANSACTION',
    messageId: randomUUID(),
    payload: {
      type: 'BET',
      walletId,
      providerId: 'sqs-demo',
      externalTransactionId: `bet-${randomUUID()}`,
      amount,
      currency: 'BRL',
    },
  });

  const body = JSON.stringify(event);

  const sqs = createSqsClient();

  try {
    const { main } = getSqsQueueNames();

    const queue = await sqs.send(
      new GetQueueUrlCommand({
        QueueName: main,
      }),
    );

    if (!queue.QueueUrl) {
      throw new Error('Wager queue not found');
    }

    const duplicates = option === '--duplicate' ? 2 : 1;

    for (let index = 0; index < duplicates; index++) {
      const sent = await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl,
          MessageBody: body,
          MessageGroupId: walletId,

          // No modo --duplicate, alteramos deliberadamente
          // o ID de deduplicação do SQS para testar a Inbox.
          MessageDeduplicationId: duplicates === 2 ? randomUUID() : event.messageId,
        }),
      );

      console.log('Message sent', {
        sqsMessageId: sent.MessageId,
        inboxMessageId: event.messageId,
        externalTransactionId: event.payload.externalTransactionId,
      });
    }
  } finally {
    sqs.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
