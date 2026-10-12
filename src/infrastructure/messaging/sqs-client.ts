import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;

  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',

    ...(endpoint ? { endpoint } : {}),
  });
}
