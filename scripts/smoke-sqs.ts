import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';
import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';

async function main(): Promise<void> {
  const client = createSqsClient();

  try {
    const { main } = getSqsQueueNames();

    const queue = await client.send(
      new GetQueueUrlCommand({
        QueueName: main,
      }),
    );

    const queueUrl = queue.QueueUrl;

    if (!queueUrl) {
      throw new Error('Main queue not found');
    }

    const testId = randomUUID();

    const body = JSON.stringify({
      kind: 'SQS_SMOKE_TEST',
      testId,
      createdAt: new Date().toISOString(),
    });
    const sent = await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: `smoke-${testId}`,
        MessageDeduplicationId: testId,
      }),
    );

    if (!sent.MessageId) {
      throw new Error('SQS did not return a message ID');
    }

    console.log(`Message sent: ${sent.MessageId}`);
    let found = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 3,
        }),
      );

      for (const message of response.Messages ?? []) {
        if (message.Body !== body) {
          continue;
        }

        if (!message.ReceiptHandle) {
          throw new Error('Missing receipt handle');
        }

        console.log('Message received and validated');

        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        console.log('Message acknowledged and deleted');
        found = true;
        break;
      }

      if (found) {
        break;
      }
    }

    if (!found) {
      throw new Error('Smoke test message was not received');
    }

    console.log('SQS smoke test passed');
  } finally {
    client.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
