import 'dotenv/config';

import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

import { WalletEntity } from '../persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../persistence/entities/wager-transaction.entity';

import { SqsInboxMessageEntity } from '../persistence/entities/sqs-inbox-message.entity';
import { WagerOutboxEventEntity } from '../persistence/entities/wager-outbox-event.entity';

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}
const connectionMode = process.env.DB_CONNECTION_MODE ?? 'app';

if (connectionMode !== 'app' && connectionMode !== 'admin') {
  throw new Error('Invalid DB_CONNECTION_MODE');
}

const adminConnection = connectionMode === 'admin';

export default defineConfig({
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),

  schemaGenerator: {
    ignoreTriggers: true,
    ignoreRoutines: true,
  },

  dbName: requiredEnv('POSTGRES_DB'),
  user: requiredEnv(adminConnection ? 'POSTGRES_USER' : 'POSTGRES_APP_USER'),

  password: requiredEnv(adminConnection ? 'POSTGRES_PASSWORD' : 'POSTGRES_APP_PASSWORD'),

  entities: [
    WalletEntity,
    WalletLedgerEntryEntity,
    WagerTransactionEntity,
    SqsInboxMessageEntity,
    WagerOutboxEventEntity,
  ],

  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],

  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
  },
});
