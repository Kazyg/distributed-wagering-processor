import { randomUUID } from 'node:crypto';
import { DecimalType } from '@mikro-orm/core';
import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
@Check({ expression: 'balance >= 0' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'string', length: 128 })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balance: string = '0.00';

  @Property({ type: 'integer', version: true })
  version: number = 1;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
