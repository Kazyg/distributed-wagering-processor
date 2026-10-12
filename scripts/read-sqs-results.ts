import 'dotenv/config';

import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';

async function main(): Promise<void> {
  const acknowledge = process.argv.includes('--ack');

  const sqs = createSqsClient();

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

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
      }),
    );

    const messages = received.Messages ?? [];

    if (messages.length === 0) {
      console.log('No visible result messages');
      return;
    }

    for (const message of messages) {
      if (!message.Body) {
        continue;
      }

      const event: unknown = JSON.parse(message.Body);

      console.log('[sqs-results] Event:', JSON.stringify(event, null, 2));

      if (acknowledge && message.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queue.QueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        console.log('[sqs-results] ACK:', message.MessageId);
      }
    }
  } finally {
    sqs.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
