import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';

export interface ClaimedOutboxEvent {
  eventId: string;
  walletId: string;
  body: string;
  claimToken: string;
  attemptCount: number;
}

import { outboxRetryDelayMs } from '../../application/wagering/outbox-retry-policy';

export class PostgresOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async claimNext(targetEventId?: string): Promise<ClaimedOutboxEvent | null> {
    const token = randomUUID();

    const rows = await this.em.fork().execute<ClaimedOutboxEvent[]>(
      `
      WITH candidate AS (
        SELECT o.id
        FROM public.wager_outbox_events AS o
        WHERE o.published_at IS NULL
          AND o.next_attempt_at <= NOW()
          AND (
            o.claimed_until IS NULL
            OR o.claimed_until < NOW()
          )
          AND (?::uuid IS NULL OR o.event_id = ?::uuid)
          AND NOT EXISTS (
            SELECT 1
            FROM public.wager_outbox_events AS earlier
            WHERE earlier.wallet_id = o.wallet_id
              AND earlier.id < o.id
              AND earlier.published_at IS NULL
          )
        ORDER BY o.id
        FOR UPDATE OF o SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.wager_outbox_events AS o
      SET
        claim_token = ?::uuid,
        claimed_until = NOW() + INTERVAL '120 seconds',
        attempt_count = o.attempt_count + 1
      FROM candidate
      WHERE o.id = candidate.id
      RETURNING
        o.event_id AS "eventId",
        o.wallet_id AS "walletId",
        o.payload::text AS "body",
        o.claim_token AS "claimToken",
        o.attempt_count AS "attemptCount"
      `,
      [targetEventId ?? null, targetEventId ?? null, token],
    );

    return rows[0] ?? null;
  }

  async markPublished(eventId: string, claimToken: string): Promise<boolean> {
    const rows = await this.em.fork().execute<{ eventId: string }[]>(
      `
      UPDATE public.wager_outbox_events
      SET
        published_at = NOW(),
        claim_token = NULL,
        claimed_until = NULL,
        last_error = NULL
      WHERE event_id = ?::uuid
        AND claim_token = ?::uuid
        AND published_at IS NULL
      RETURNING event_id AS "eventId"
      `,
      [eventId, claimToken],
    );

    return rows.length === 1;
  }

  async recordFailure(event: ClaimedOutboxEvent, error: unknown): Promise<boolean> {
    const delay = outboxRetryDelayMs(event.attemptCount);

    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);

    const rows = await this.em.fork().execute<{ eventId: string }[]>(
      `
      UPDATE public.wager_outbox_events
      SET
        next_attempt_at =
          NOW() + (?::integer * INTERVAL '1 millisecond'),
        claim_token = NULL,
        claimed_until = NULL,
        last_error = ?
      WHERE event_id = ?::uuid
        AND claim_token = ?::uuid
        AND published_at IS NULL
      RETURNING event_id AS "eventId"
      `,
      [delay, message, event.eventId, event.claimToken],
    );

    return rows.length === 1;
  }
}
