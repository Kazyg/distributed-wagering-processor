import {
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import type { WagerResultEvent } from '../../../application/wagering/wager-result-event';
import { WalletEntity } from './wallet.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';

@Entity({ tableName: 'wager_outbox_events' })
@Unique({
  name: 'uq_wager_outbox_transaction',
  properties: ['wager'],
})
@Index({
  name: 'idx_wager_outbox_due',
  properties: ['nextAttemptAt'],
  where: 'published_at IS NULL',
})
@Index({
  name: 'idx_wager_outbox_wallet_order',
  properties: ['wallet', 'id'],
  where: 'published_at IS NULL',
})
export class WagerOutboxEventEntity {
  @PrimaryKey({ type: 'bigint', autoincrement: true })
  id!: bigint;

  @Property({ type: 'uuid', unique: true })
  eventId!: string;

  @ManyToOne({
    entity: () => WagerTransactionEntity,
    fieldName: 'transaction_id',
    deleteRule: 'restrict',
  })
  wager!: WagerTransactionEntity;

  @ManyToOne({
    entity: () => WalletEntity,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: WalletEntity;

  @Property({ type: 'json' })
  payload!: WagerResultEvent;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  publishedAt: Date | null = null;

  @Property({ type: 'integer' })
  attemptCount = 0;

  @Property({ type: 'datetime' })
  nextAttemptAt: Date = new Date();

  @Property({ type: 'uuid', nullable: true })
  claimToken: string | null = null;

  @Property({ type: 'datetime', nullable: true })
  claimedUntil: Date | null = null;

  @Property({ type: 'text', nullable: true })
  lastError: string | null = null;
}
