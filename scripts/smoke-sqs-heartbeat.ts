import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

import { withVisibilityHeartbeat } from '../src/infrastructure/messaging/sqs-visibility-heartbeat';

async function main(): Promise<void> {
  const endpoint = process.env.SQS_ENDPOINT;

  if (!endpoint) {
    throw new Error('SQS_ENDPOINT is required');
  }

  const url = new URL(endpoint);

  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '4566'
  ) {
    throw new Error('Heartbeat smoke test only supports local LocalStack');
  }

  const sqs = createSqsClient();

  let queueUrl: string | undefined;

  try {
    const testId = randomUUID();

    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-heartbeat-${testId}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          VisibilityTimeout: '2',
          ReceiveMessageWaitTimeSeconds: '1',
        },
      }),
    );

    queueUrl = created.QueueUrl;

    if (!queueUrl) {
      throw new Error('Could not create heartbeat test queue');
    }

    const body = JSON.stringify({
      kind: 'HEARTBEAT_SMOKE_TEST',
      testId,
    });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: testId,
        MessageDeduplicationId: testId,
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );

    const message = received.Messages?.[0];

    if (message?.Body !== body || !message.ReceiptHandle) {
      throw new Error('Heartbeat test message not received');
    }

    const receiptHandle = message.ReceiptHandle;

    let renewals = 0;
    let renewalFailures = 0;

    await withVisibilityHeartbeat(
      async () => {
        await Bun.sleep(2_500);
        const competingReceive = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
          }),
        );

        if ((competingReceive.Messages ?? []).length > 0) {
          throw new Error('Message became visible during heartbeat');
        }
      },

      async () => {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 2,
          }),
        );
      },

      {
        intervalMs: 400,

        onRenewed: () => {
          renewals += 1;
        },

        onError: (error) => {
          renewalFailures += 1;
          console.error('[heartbeat] Renewal failed', error);
        },
      },
    );

    if (renewals === 0 || renewalFailures > 0) {
      throw new Error('Heartbeat renewal was not successful');
    }

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );

    console.log('[heartbeat] Message remained invisible');
    console.log(`[heartbeat] Renewals: ${renewals}`);
    console.log('[heartbeat] ACK succeeded');
    console.log('[heartbeat] All checks passed');
  } finally {
    if (queueUrl) {
      await sqs.send(
        new DeleteQueueCommand({
          QueueUrl: queueUrl,
        }),
      );
    }

    sqs.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
