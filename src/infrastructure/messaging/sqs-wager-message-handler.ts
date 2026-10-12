import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { withVisibilityHeartbeat } from './sqs-visibility-heartbeat';

import {
  type InboxProcessResult,
  type PostgresSqsInboxProcessor,
} from './postgres-sqs-inbox.processor';

export interface HandledWagerMessage {
  result: InboxProcessResult;
  durationMs: number;
  heartbeatCount: number;
  heartbeatFailures: number;
}

export interface WagerMessageHandlerOptions {
  visibilityTimeoutSeconds?: number;
  heartbeatIntervalMs?: number;
}

export async function handleWagerSqsMessage(
  sqs: SQSClient,
  queueUrl: string,
  message: Message,
  processor: PostgresSqsInboxProcessor,
  options: WagerMessageHandlerOptions = {},
): Promise<HandledWagerMessage> {
  const body = message.Body;
  const receiptHandle = message.ReceiptHandle;

  if (!body || !receiptHandle) {
    throw new Error('SQS message is missing body or receipt handle');
  }

  const visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 60;

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;

  if (visibilityTimeoutSeconds < 1 || visibilityTimeoutSeconds > 43_200) {
    throw new Error('Invalid SQS visibility timeout');
  }

  const startedAt = performance.now();

  let heartbeatCount = 0;
  let heartbeatFailures = 0;

  // O processamento financeiro e a Inbox são
  // confirmados no PostgreSQL antes do ACK.
  const result = await withVisibilityHeartbeat(
    () => processor.process(body),

    async () => {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilityTimeoutSeconds,
        }),
      );
    },

    {
      intervalMs: heartbeatIntervalMs,

      onRenewed: () => {
        heartbeatCount += 1;
      },

      onError: (error) => {
        heartbeatFailures += 1;

        console.error('[sqs-consumer] Heartbeat failure', {
          sqsMessageId: message.MessageId,
          error,
        });
      },
    },
  );

  // Neste ponto o processor.process() já retornou
  // e a transação PostgreSQL foi confirmada.
  //
  // Se DeleteMessage falhar, o SQS poderá reenviar
  // a mensagem, e a Inbox reconhecerá a duplicata.
  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  );

  return {
    result,
    durationMs: Math.round(performance.now() - startedAt),
    heartbeatCount,
    heartbeatFailures,
  };
}
