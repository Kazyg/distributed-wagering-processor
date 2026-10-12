import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/wagering/process-bet.use-case';
import { ProcessOutcomeUseCase } from '../../src/application/wagering/process-outcome.use-case';
import { ProcessReversalUseCase } from '../../src/application/wagering/process-reversal.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';
import { PostgresOutboxRepository } from '../../src/infrastructure/persistence/postgres-outbox.repository';

import { WagerOutboxEventEntity } from '../../src/infrastructure/persistence/entities/wager-outbox-event.entity';

import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import { SqsOutboxPublisher } from '../../src/infrastructure/messaging/sqs-outbox.publisher';

describe('Transactional Wager Outbox', () => {
  let orm: MikroORM;

  const providerId = 'outbox-tests';

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  function wagers(): PostgresBetRepository {
    return new PostgresBetRepository(orm.em.fork());
  }

  function outbox(): PostgresOutboxRepository {
    return new PostgresOutboxRepository(orm.em.fork());
  }

  async function createWallet(): Promise<string> {
    const creator = new CreateWalletUseCase(new PostgresWalletRepository(orm.em.fork()));

    const result = await creator.execute({
      playerId: `outbox-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    return result.id;
  }

  async function bet(walletId: string, externalTransactionId = randomUUID(), amount = '30.00') {
    return new ProcessBetUseCase(wagers()).execute({
      walletId,
      providerId,
      externalTransactionId,
      amount,
      currency: 'BRL',
    });
  }

  async function findEvent(transactionId: string) {
    return orm.em.fork().findOneOrFail(WagerOutboxEventEntity, { wager: transactionId });
  }

  test('should persist a financial result and its Outbox event', async () => {
    const walletId = await createWallet();
    const result = await bet(walletId);

    const event = await findEvent(result.transactionId);

    expect(result.status).toBe('PROCESSED');
    expect(event.publishedAt).toBeNull();
    expect(event.attemptCount).toBe(0);

    expect(event.payload.transactionId).toBe(result.transactionId);

    expect(event.payload.eventId).toBe(event.eventId);
    expect(event.payload.kind).toBe('WAGER_TRANSACTION_FINALIZED');

    expect(event.payload.type).toBe('BET');
    expect(event.payload.status).toBe('PROCESSED');
    expect(event.payload.balanceAfter).toBe('70.00');
  });

  test('should not create a second event for an idempotent replay', async () => {
    const walletId = await createWallet();
    const externalId = randomUUID();

    const first = await bet(walletId, externalId);
    const replay = await bet(walletId, externalId);

    expect(replay).toEqual(first);

    const eventCount = await orm.em
      .fork()
      .count(WagerOutboxEventEntity, { wager: first.transactionId });

    expect(eventCount).toBe(1);
  });

  test('should publish events from one wallet in sequence', async () => {
    const walletId = await createWallet();

    const first = await bet(walletId, randomUUID(), '10.00');

    const second = await new ProcessOutcomeUseCase(wagers()).execute({
      walletId,
      providerId,
      externalTransactionId: randomUUID(),
      type: 'WIN',
      amount: '5.00',
      currency: 'BRL',
    });

    const firstEvent = await findEvent(first.transactionId);
    const secondEvent = await findEvent(second.transactionId);

    const firstClaim = await outbox().claimNext(firstEvent.eventId);

    expect(firstClaim).not.toBeNull();

    if (!firstClaim) {
      throw new Error('Expected first Outbox claim');
    }

    // Não deve permitir publicar WIN antes da BET.
    const blocked = await outbox().claimNext(secondEvent.eventId);

    expect(blocked).toBeNull();

    const confirmed = await outbox().markPublished(firstClaim.eventId, firstClaim.claimToken);

    expect(confirmed).toBe(true);

    const secondClaim = await outbox().claimNext(secondEvent.eventId);

    expect(secondClaim?.eventId).toBe(secondEvent.eventId);
  });

  test('should allow only one publisher to claim an event', async () => {
    const walletId = await createWallet();
    const result = await bet(walletId);
    const event = await findEvent(result.transactionId);

    const claims = await Promise.all([
      outbox().claimNext(event.eventId),
      outbox().claimNext(event.eventId),
    ]);

    const successful = claims.filter((claim) => claim !== null);

    expect(successful).toHaveLength(1);
  });

  test('should retry failed publication without losing the event', async () => {
    const walletId = await createWallet();
    const result = await bet(walletId);
    const event = await findEvent(result.transactionId);

    const firstClaim = await outbox().claimNext(event.eventId);

    if (!firstClaim) {
      throw new Error('Expected Outbox claim');
    }

    const released = await outbox().recordFailure(
      firstClaim,
      new Error('SQS temporarily unavailable'),
    );

    expect(released).toBe(true);

    const beforeRetry = await findEvent(result.transactionId);

    expect(beforeRetry.publishedAt).toBeNull();
    expect(beforeRetry.lastError).toContain('SQS temporarily unavailable');

    const notDue = await outbox().claimNext(event.eventId);

    expect(notDue).toBeNull();

    // Adianta somente o agendamento desse teste.
    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
      UPDATE public.wager_outbox_events
      SET next_attempt_at = NOW() - INTERVAL '1 second'
      WHERE event_id = ?::uuid
      `,
        [event.eventId],
      );

    const secondClaim = await outbox().claimNext(event.eventId);

    expect(secondClaim?.attemptCount).toBe(2);
  });

  test('should finalize a pending reference with an Outbox event', async () => {
    const walletId = await createWallet();
    const originalId = randomUUID();

    const pending = await new ProcessReversalUseCase(wagers()).execute({
      walletId,
      providerId,
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: originalId,
      type: 'REFUND',
      amount: '30.00',
      currency: 'BRL',
    });

    expect(pending.status).toBe('PENDING_REFERENCE');

    const pendingCount = await orm.em
      .fork()
      .count(WagerOutboxEventEntity, { wager: pending.transactionId });

    expect(pendingCount).toBe(0);

    await bet(walletId, originalId);

    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
      UPDATE public.wager_transactions
      SET next_retry_at = NOW() - INTERVAL '1 second'
      WHERE id = ?::uuid
      `,
        [pending.transactionId],
      );

    const processed = await wagers().processNextPending(pending.transactionId);

    expect(processed).toBe('PROCESSED');

    const finalEvent = await findEvent(pending.transactionId);

    expect(finalEvent.payload.type).toBe('REFUND');
    expect(finalEvent.payload.status).toBe('PROCESSED');
    expect(finalEvent.payload.balanceAfter).toBe('100.00');
  });

  test('should recover an expired publisher claim', async () => {
    const walletId = await createWallet();
    const result = await bet(walletId);
    const event = await findEvent(result.transactionId);

    const firstClaim = await outbox().claimNext(event.eventId);

    if (!firstClaim) {
      throw new Error('Expected initial claim');
    }

    // Simula a passagem do prazo de reserva.
    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
    UPDATE public.wager_outbox_events
    SET claimed_until = NOW() - INTERVAL '1 second'
    WHERE event_id = ?::uuid
    `,
        [event.eventId],
      );

    const recovered = await outbox().claimNext(event.eventId);

    expect(recovered).not.toBeNull();
    expect(recovered?.eventId).toBe(event.eventId);
    expect(recovered?.claimToken).not.toBe(firstClaim.claimToken);

    // O publisher antigo perdeu o direito de confirmar.
    const oldConfirmation = await outbox().markPublished(firstClaim.eventId, firstClaim.claimToken);

    expect(oldConfirmation).toBe(false);

    if (!recovered) {
      throw new Error('Expected recovered claim');
    }

    const newConfirmation = await outbox().markPublished(recovered.eventId, recovered.claimToken);

    expect(newConfirmation).toBe(true);

    const saved = await findEvent(result.transactionId);

    expect(saved.publishedAt).not.toBeNull();
  });

  test('should recover Outbox after an SQS publication failure', async () => {
    const walletId = await createWallet();

    const wager = await bet(walletId);

    const event = await findEvent(wager.transactionId);

    // Cliente falso: simula indisponibilidade do SQS.
    const failingSqs = {
      async send(): Promise<never> {
        throw new Error('Simulated SQS outage');
      },
    } as unknown as SQSClient;

    const firstPublisher = new SqsOutboxPublisher(
      outbox(),
      failingSqs,
      'http://localhost:4566/fake-results-queue',
    );

    const firstResult = await firstPublisher.publishNext(event.eventId);

    expect(firstResult).toBe('FAILED');

    const failedEvent = await findEvent(wager.transactionId);

    expect(failedEvent.publishedAt).toBeNull();
    expect(failedEvent.attemptCount).toBe(1);
    expect(failedEvent.lastError).toContain('Simulated SQS outage');
    expect(failedEvent.claimToken).toBeNull();
    expect(failedEvent.claimedUntil).toBeNull();

    // Adianta o retry somente no banco de testes.
    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
    UPDATE public.wager_outbox_events
    SET next_attempt_at = NOW() - INTERVAL '1 second'
    WHERE event_id = ?::uuid
    `,
        [event.eventId],
      );

    // Cliente falso: desta vez o SQS aceita a mensagem.
    const successfulSqs = {
      async send(command: SendMessageCommand) {
        expect(command.input.MessageGroupId).toBe(walletId);
        expect(command.input.MessageDeduplicationId).toBe(event.eventId);

        return {
          MessageId: randomUUID(),
        };
      },
    } as unknown as SQSClient;

    const secondPublisher = new SqsOutboxPublisher(
      outbox(),
      successfulSqs,
      'http://localhost:4566/fake-results-queue',
    );

    const secondResult = await secondPublisher.publishNext(event.eventId);

    expect(secondResult).toBe('PUBLISHED');

    const publishedEvent = await findEvent(wager.transactionId);

    expect(publishedEvent.publishedAt).not.toBeNull();
    expect(publishedEvent.attemptCount).toBe(2);
    expect(publishedEvent.lastError).toBeNull();
    expect(publishedEvent.claimToken).toBeNull();

    // O evento original continua sendo o mesmo.
    expect(publishedEvent.eventId).toBe(event.eventId);
    expect(publishedEvent.payload.transactionId).toBe(wager.transactionId);
  });

  test('should preserve event identity when publish confirmation is lost', async () => {
    const walletId = await createWallet();
    const wager = await bet(walletId);
    const event = await findEvent(wager.transactionId);

    const sentIds: string[] = [];

    const sqs = {
      async send(command: SendMessageCommand) {
        const deduplicationId = command.input.MessageDeduplicationId;

        if (!deduplicationId) {
          throw new Error('Missing deduplication ID');
        }

        sentIds.push(deduplicationId);

        return { MessageId: randomUUID() };
      },
    } as unknown as SQSClient;

    const repository = outbox();

    const realMarkPublished = repository.markPublished.bind(repository);

    let simulateLostConfirmation = true;

    repository.markPublished = async (eventId, claimToken) => {
      if (simulateLostConfirmation) {
        simulateLostConfirmation = false;
        return false;
      }

      return realMarkPublished(eventId, claimToken);
    };

    const publisher = new SqsOutboxPublisher(
      repository,
      sqs,
      'http://localhost:4566/fake-results-queue',
    );

    const first = await publisher.publishNext(event.eventId);

    expect(first).toBe('FAILED');

    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
    UPDATE public.wager_outbox_events
    SET next_attempt_at = NOW() - INTERVAL '1 second'
    WHERE event_id = ?::uuid
    `,
        [event.eventId],
      );

    const second = await publisher.publishNext(event.eventId);

    expect(second).toBe('PUBLISHED');

    expect(sentIds).toEqual([event.eventId, event.eventId]);

    const stored = await findEvent(wager.transactionId);

    expect(stored.attemptCount).toBe(2);
    expect(stored.publishedAt).not.toBeNull();
  });
});
