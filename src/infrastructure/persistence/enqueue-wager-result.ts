import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';

import type { WagerResultEvent } from '../../application/wagering/wager-result-event';

import { WagerOutboxEventEntity } from './entities/wager-outbox-event.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

export function enqueueWagerResult(tx: EntityManager, wager: WagerTransactionEntity): void {
  if (wager.status !== 'PROCESSED' && wager.status !== 'REJECTED') {
    return;
  }

  const eventId = randomUUID();

  const payload: WagerResultEvent = {
    schemaVersion: 1,
    kind: 'WAGER_TRANSACTION_FINALIZED',

    eventId,
    transactionId: wager.id,
    walletId: wager.wallet.id,

    providerId: wager.providerId,
    externalTransactionId: wager.externalTransactionId,

    type: wager.type,
    status: wager.status,

    amount: wager.amount,
    currency: wager.currency,
    balanceAfter: wager.balanceAfter,

    reason: wager.reason,
    referenceExternalTransactionId: wager.referenceExternalTransactionId,

    occurredAt: new Date().toISOString(),
  };

  const event = new WagerOutboxEventEntity();

  event.eventId = eventId;
  event.wager = wager;
  event.wallet = wager.wallet;
  event.payload = payload;

  tx.persist(event);
}
