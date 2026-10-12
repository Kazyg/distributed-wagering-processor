import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import type { LedgerDirection, LedgerOperation } from '../../../domain/ledger/ledger-entry';
import { WalletEntity } from './wallet.entity';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['wallet', 'transactionId'] })
@Unique({
  name: 'uq_ledger_one_opening_per_wallet',
  properties: ['wallet'],
  where: "operation = 'OPENING'",
})
@Check({
  name: 'ck_wallet_ledger_amount_positive',
  expression: 'amount > 0',
})
@Check({
  name: 'ck_wallet_ledger_balances_nonnegative',
  expression: 'balance_before >= 0 AND balance_after >= 0',
})
@Check({
  name: 'ck_wallet_ledger_balance_consistency',
  expression: `
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR
    (direction = 'DEBIT' AND balance_after = balance_before - amount)
  `,
})
@Check({
  name: 'ck_ledger_reference_by_operation',
  expression: `
    (
      operation = 'OPENING'
      AND transaction_id IS NULL
    )
    OR
    (
      operation <> 'OPENING'
      AND transaction_id IS NOT NULL
    )
  `,
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne({
    entity: () => WalletEntity,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: WalletEntity;

  @Property({ type: 'uuid', nullable: true })
  transactionId: string | null = null;

  @Property({ type: 'string', length: 16 })
  operation!: LedgerOperation;

  @Property({ type: 'string', length: 6 })
  direction!: LedgerDirection;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  occurredAt!: Date;
}
