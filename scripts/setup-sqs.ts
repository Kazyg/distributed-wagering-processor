import 'dotenv/config';

import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';
import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';
function assertLocalStack(): void {
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
    throw new Error('This provision script only supports local LocalStack');
  }
}

function isMissingQueue(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'QueueDoesNotExist' || error.name === 'AWS.SimpleQueueService.NonExistentQueue')
  );
}

async function ensureQueue(client: SQSClient, name: string): Promise<string> {
  try {
    const existing = await client.send(
      new GetQueueUrlCommand({
        QueueName: name,
      }),
    );

    if (!existing.QueueUrl) {
      throw new Error(`Missing QueueUrl for ${name}`);
    }

    return existing.QueueUrl;
  } catch (error: unknown) {
    if (!isMissingQueue(error)) {
      throw error;
    }
  }

  const created = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
      },
    }),
  );

  if (!created.QueueUrl) {
    throw new Error(`Failed to create queue ${name}`);
  }

  return created.QueueUrl;
}

async function main(): Promise<void> {
  assertLocalStack();

  const client = createSqsClient();
  const names = getSqsQueueNames();

  try {
    const dlqUrl = await ensureQueue(client, names.dlq);

    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        Attributes: {
          MessageRetentionPeriod: '1209600',
          ReceiveMessageWaitTimeSeconds: '10',
        },
      }),
    );

    const dlqAttributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn', 'FifoQueue'],
      }),
    );

    const dlqArn = dlqAttributes.Attributes?.QueueArn;

    if (!dlqArn) {
      throw new Error('Could not retrieve DLQ ARN');
    }

    if (dlqAttributes.Attributes?.FifoQueue !== 'true') {
      throw new Error('DLQ must be FIFO');
    }
    const mainUrl = await ensureQueue(client, names.main);

    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: mainUrl,
        Attributes: {
          VisibilityTimeout: '60',
          ReceiveMessageWaitTimeSeconds: '10',
          MessageRetentionPeriod: '345600',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    const mainAttributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: mainUrl,
        AttributeNames: ['FifoQueue', 'VisibilityTimeout', 'RedrivePolicy'],
      }),
    );

    if (mainAttributes.Attributes?.FifoQueue !== 'true') {
      throw new Error('Main queue must be FIFO');
    }

    const redrivePolicy = mainAttributes.Attributes?.RedrivePolicy;

    if (!redrivePolicy) {
      throw new Error('Redrive policy was not configured');
    }

    const configuredPolicy = JSON.parse(redrivePolicy) as {
      deadLetterTargetArn: string;
      maxReceiveCount: string;
    };

    if (
      configuredPolicy.deadLetterTargetArn !== dlqArn ||
      String(configuredPolicy.maxReceiveCount) !== '5'
    ) {
      throw new Error('Invalid SQS redrive configuration');
    }

    const resultsDlqUrl = await ensureQueue(client, names.resultsDlq);

    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: resultsDlqUrl,
        Attributes: {
          MessageRetentionPeriod: '1209600',
          ReceiveMessageWaitTimeSeconds: '10',
        },
      }),
    );

    const resultsDlqAttributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: resultsDlqUrl,
        AttributeNames: ['QueueArn', 'FifoQueue'],
      }),
    );

    const resultsDlqArn = resultsDlqAttributes.Attributes?.QueueArn;

    if (!resultsDlqArn || resultsDlqAttributes.Attributes?.FifoQueue !== 'true') {
      throw new Error('Invalid results DLQ');
    }

    const resultsUrl = await ensureQueue(client, names.results);

    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: resultsUrl,
        Attributes: {
          VisibilityTimeout: '60',
          ReceiveMessageWaitTimeSeconds: '10',
          MessageRetentionPeriod: '345600',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: resultsDlqArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );

    console.log(`Results queue: ${resultsUrl}`);
    console.log(`Results DLQ: ${resultsDlqUrl}`);
    console.log('SQS infrastructure configured');
    console.log(`Main queue: ${mainUrl}`);
    console.log(`Dead-letter queue: ${dlqUrl}`);
    console.log(`Visibility timeout: 60 seconds`);
    console.log(`Maximum receives: 5`);
  } finally {
    client.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
