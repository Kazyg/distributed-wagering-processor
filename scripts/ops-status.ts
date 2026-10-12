import 'reflect-metadata';

import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

import { getSqsQueueNames } from '../src/infrastructure/messaging/sqs-queue-names';

interface OutboxMetrics {
  pending: number;
  claimed: number;
  withError: number;
  oldestPendingSeconds: number | null;
}

interface ReferenceMetrics {
  pending: number;
  due: number;
}

interface TriggerMetrics {
  ledgerProtected: boolean;
  wagerStatusProtected: boolean;
}

interface QueueMetrics {
  name: string;
  visible: number | null;
  inFlight: number | null;
  delayed: number | null;
}

function approximateCount(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  const sqs = createSqsClient();

  try {
    const em = orm.em.fork();

    const outbox = await em.execute<OutboxMetrics>(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE published_at IS NULL
        )::integer AS "pending",

        COUNT(*) FILTER (
          WHERE published_at IS NULL
            AND claimed_until > NOW()
        )::integer AS "claimed",

        COUNT(*) FILTER (
          WHERE published_at IS NULL
            AND last_error IS NOT NULL
        )::integer AS "withError",

        ROUND(
          EXTRACT(
            EPOCH FROM (
              NOW() - MIN(created_at) FILTER (
                WHERE published_at IS NULL
              )
            )
          )
        )::integer AS "oldestPendingSeconds"

      FROM public.wager_outbox_events
      `,
      [],
      'get',
    );

    const references = await em.execute<ReferenceMetrics>(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'PENDING_REFERENCE'
        )::integer AS "pending",

        COUNT(*) FILTER (
          WHERE status = 'PENDING_REFERENCE'
            AND next_retry_at <= NOW()
        )::integer AS "due"

      FROM public.wager_transactions
      `,
      [],
      'get',
    );

    const triggers = await em.execute<TriggerMetrics>(
      `
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid =
            'public.wallet_ledger_entries'::regclass
            AND tgname = 'trg_wallet_ledger_immutable'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS "ledgerProtected",

        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid =
            'public.wager_transactions'::regclass
            AND tgname = 'trg_wager_status_guard'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS "wagerStatusProtected"
      `,
      [],
      'get',
    );

    const queueMetrics: Record<string, QueueMetrics> = {};

    for (const [key, name] of Object.entries(getSqsQueueNames())) {
      const queue = await sqs.send(
        new GetQueueUrlCommand({
          QueueName: name,
        }),
      );

      if (!queue.QueueUrl) {
        throw new Error(`SQS queue not found: ${name}`);
      }

      const response = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queue.QueueUrl,

          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
      );

      const attributes = response.Attributes ?? {};

      queueMetrics[key] = {
        name,
        visible: approximateCount(attributes.ApproximateNumberOfMessages),
        inFlight: approximateCount(attributes.ApproximateNumberOfMessagesNotVisible),
        delayed: approximateCount(attributes.ApproximateNumberOfMessagesDelayed),
      };
    }

    const warnings: string[] = [];

    if (!triggers.ledgerProtected) {
      warnings.push('Ledger protection trigger is missing or disabled');
    }

    if (!triggers.wagerStatusProtected) {
      warnings.push('Wager status guard is missing or disabled');
    }

    if (
      queueMetrics.dlq?.visible !== null &&
      queueMetrics.dlq?.visible !== undefined &&
      queueMetrics.dlq.visible > 0
    ) {
      warnings.push('Input DLQ contains messages');
    }

    if (
      queueMetrics.resultsDlq?.visible !== null &&
      queueMetrics.resultsDlq?.visible !== undefined &&
      queueMetrics.resultsDlq.visible > 0
    ) {
      warnings.push('Results DLQ contains messages');
    }

    if (outbox.oldestPendingSeconds !== null && outbox.oldestPendingSeconds > 60) {
      warnings.push('Oldest unpublished Outbox event exceeds 60s');
    }

    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          database: {
            outbox,
            references,
            triggers,
          },
          sqs: queueMetrics,
          warnings,
        },
        null,
        2,
      ),
    );
    if (!triggers.ledgerProtected || !triggers.wagerStatusProtected) {
      process.exitCode = 1;
    }
  } finally {
    sqs.destroy();
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error('Reference worker failed:', error);
  process.exitCode = 1;
});
