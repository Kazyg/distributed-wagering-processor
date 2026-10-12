import { randomUUID } from 'node:crypto';
import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { Index } from '@mikro-orm/decorators/legacy';

import type {
  WagerStatus,
  TransactionRejectionReason,
} from '../../../domain/wagering-transaction/transaction-status';

import { WalletEntity } from './wallet.entity';
import type { WagerOperation } from '../../../domain/wagering-transaction/wager-operation';

export type BetRejectionReason = TransactionRejectionReason;

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'uq_wager_provider_external',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'uq_processed_reversal_target',
  properties: ['referenceTransaction'],
  where: "type in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'",
})
@Unique({
  name: 'uq_wager_transaction_id_wallet',
  properties: ['id', 'wallet'],
})
@Index({
  name: 'idx_wager_pending_retry',
  properties: ['nextRetryAt'],
  where: { status: 'PENDING_REFERENCE' },
})
@Check({
  name: 'ck_wager_pending_retry_date',
  expression: `
    status <> 'PENDING_REFERENCE'
    OR next_retry_at IS NOT NULL
  `,
})
@Check({
  name: 'ck_wager_retry_count_nonnegative',
  expression: 'retry_count >= 0',
})
@Check({
  name: 'ck_wager_amount_positive',
  expression: 'amount > 0',
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne({
    entity: () => WalletEntity,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: WalletEntity;

  @ManyToOne({
    entity: () => WagerTransactionEntity,
    fieldName: 'reference_transaction_id',
    nullable: true,
    deleteRule: 'restrict',
  })
  referenceTransaction: WagerTransactionEntity | null = null;

  @Property({
    type: 'string',
    length: 128,
    nullable: true,
  })
  referenceExternalTransactionId: string | null = null;

  @Property({ type: 'string', length: 128 })
  providerId!: string;

  @Property({ type: 'string', length: 128 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 10 })
  type: WagerOperation = 'BET';

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 32 })
  status!: WagerStatus;

  @Property({ type: 'string', length: 32, nullable: true })
  reason: TransactionRejectionReason | null = null;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'integer' })
  retryCount: number = 0;

  @Property({ type: 'datetime', nullable: true })
  nextRetryAt: Date | null = null;
}
