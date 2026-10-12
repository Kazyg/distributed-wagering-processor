import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import { PostgresOutboxRepository } from '../persistence/postgres-outbox.repository';

export type OutboxPublishResult = 'EMPTY' | 'PUBLISHED' | 'FAILED';

export class SqsOutboxPublisher {
  constructor(
    private readonly repository: PostgresOutboxRepository,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishNext(targetEventId?: string): Promise<OutboxPublishResult> {
    const event = await this.repository.claimNext(targetEventId);

    if (!event) {
      return 'EMPTY';
    }

    try {
      const sent = await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: event.body,
          MessageGroupId: event.walletId,
          MessageDeduplicationId: event.eventId,
        }),
        {
          abortSignal: AbortSignal.timeout(15_000),
        },
      );

      if (!sent.MessageId) {
        throw new Error('SQS did not return MessageId');
      }

      const confirmed = await this.repository.markPublished(event.eventId, event.claimToken);

      if (!confirmed) {
        throw new Error('Outbox claim is no longer valid');
      }

      console.log('[outbox-publisher] Published', {
        eventId: event.eventId,
        sqsMessageId: sent.MessageId,
        attempts: event.attemptCount,
      });

      return 'PUBLISHED';
    } catch (error: unknown) {
      const released = await this.repository.recordFailure(event, error);

      console.error('[outbox-publisher] Publication failed', {
        eventId: event.eventId,
        attempt: event.attemptCount,
        released,
        error,
      });

      return 'FAILED';
    }
  }
}
