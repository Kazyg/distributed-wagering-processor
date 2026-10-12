import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { ProcessBetUseCase } from '../../application/wagering/process-bet.use-case';

import { ProcessOutcomeUseCase } from '../../application/wagering/process-outcome.use-case';

import { ProcessReversalUseCase } from '../../application/wagering/process-reversal.use-case';

import { parseWagerQueueMessage } from '../../application/wagering/wager-queue-message';

import { PostgresBetRepository } from '../persistence/postgres-bet.repository';

export type InboxProcessResult =
  | {
      outcome: 'PROCESSED';
      transactionId: string;
      financialStatus: string;
    }
  | {
      outcome: 'DUPLICATE';
    };

export class InboxPayloadConflictError extends Error {
  constructor() {
    super('Inbox message ID was reused with different content');
    this.name = 'InboxPayloadConflictError';
  }
}

@Injectable()
export class PostgresSqsInboxProcessor {
  constructor(
    private readonly em: EntityManager,
    private readonly wagers: PostgresBetRepository,
  ) {}

  async process(body: string): Promise<InboxProcessResult> {
    const message = parseWagerQueueMessage(body);

    const payloadHash = createHash('sha256').update(body).digest('hex');

    return this.em.fork().transactional(async (tx) => {
      const inserted = await tx.execute<{ id: string }[]>(
        `
        INSERT INTO public.sqs_inbox_messages (
          id,
          payload_sha256,
          processed_at
        )
        VALUES (?::uuid, ?, NOW())
        ON CONFLICT (id) DO NOTHING
        RETURNING id
        `,
        [message.messageId, payloadHash],
      );

      if (inserted.length === 0) {
        const existing = await tx.execute<{ payloadHash: string }[]>(
          `
          SELECT payload_sha256 AS "payloadHash"
          FROM public.sqs_inbox_messages
          WHERE id = ?::uuid
          `,
          [message.messageId],
        );

        if (existing[0]?.payloadHash !== payloadHash) {
          throw new InboxPayloadConflictError();
        }

        return { outcome: 'DUPLICATE' };
      }
      const persistence = this.wagers.forTransaction(tx);

      const input = message.payload;

      const result =
        input.type === 'BET'
          ? await new ProcessBetUseCase(persistence).execute(input)
          : input.type === 'WIN' || input.type === 'LOSS'
            ? await new ProcessOutcomeUseCase(persistence).execute(input)
            : await new ProcessReversalUseCase(persistence).execute(input);
      return {
        outcome: 'PROCESSED',
        transactionId: result.transactionId,
        financialStatus: result.status,
      };
    });
  }
}
