import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

interface DatabasePermissions {
  username: string;
  superuser: boolean;
  ledgerSelect: boolean;
  ledgerInsert: boolean;
  ledgerUpdate: boolean;
  ledgerDelete: boolean;
  ledgerTruncate: boolean;
  walletBalanceUpdate: boolean;
  walletDelete: boolean;
  schemaCreate: boolean;
}

function getExpectedAppUser(): string {
  const user = process.env.POSTGRES_APP_USER;

  if (!user) {
    throw new Error('Missing environment variable: POSTGRES_APP_USER');
  }

  return user;
}

describe('Database least privileges', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('should connect with the application role', async () => {
    const result = await orm.em.fork().getConnection().execute<{
      username: string;
    }>('SELECT current_user AS username', [], 'get');

    expect(result.username).toBe(getExpectedAppUser());
  });

  test('should enforce minimum privileges', async () => {
    const permissions = await orm.em
      .fork()
      .getConnection()
      .execute<DatabasePermissions>(
        `
        SELECT
          current_user AS "username",

          (
            SELECT rolsuper
            FROM pg_roles
            WHERE rolname = current_user
          ) AS "superuser",

          has_table_privilege(
            current_user, 'public.wallet_ledger_entries', 'SELECT'
          ) AS "ledgerSelect",

          has_table_privilege(
            current_user, 'public.wallet_ledger_entries', 'INSERT'
          ) AS "ledgerInsert",

          has_any_column_privilege(
            current_user, 'public.wallet_ledger_entries', 'UPDATE'
          ) AS "ledgerUpdate",

          has_table_privilege(
            current_user, 'public.wallet_ledger_entries', 'DELETE'
          ) AS "ledgerDelete",

          has_table_privilege(
            current_user, 'public.wallet_ledger_entries', 'TRUNCATE'
          ) AS "ledgerTruncate",

          has_column_privilege(
            current_user, 'public.wallets', 'balance', 'UPDATE'
          ) AS "walletBalanceUpdate",

          has_table_privilege(
            current_user, 'public.wallets', 'DELETE'
          ) AS "walletDelete",

          has_schema_privilege(
            current_user, 'public', 'CREATE'
          ) AS "schemaCreate"
        `,
        [],
        'get',
      );

    expect(permissions.username).toBe(getExpectedAppUser());

    expect(permissions.superuser).toBe(false);

    expect(permissions.ledgerSelect).toBe(true);
    expect(permissions.ledgerInsert).toBe(true);

    expect(permissions.ledgerUpdate).toBe(false);
    expect(permissions.ledgerDelete).toBe(false);
    expect(permissions.ledgerTruncate).toBe(false);

    expect(permissions.walletBalanceUpdate).toBe(true);
    expect(permissions.walletDelete).toBe(false);

    expect(permissions.schemaCreate).toBe(false);
  });

  test('should protect Inbox and Outbox records', async () => {
    const permissions = await orm.em.fork().execute<{
      inboxUpdate: boolean;
      inboxDelete: boolean;
      outboxPayloadUpdate: boolean;
      outboxEventIdUpdate: boolean;
      outboxTransactionUpdate: boolean;
      outboxPublishUpdate: boolean;
      outboxDelete: boolean;
    }>(
      `
    SELECT
      has_any_column_privilege(
        current_user,
        'public.sqs_inbox_messages',
        'UPDATE'
      ) AS "inboxUpdate",

      has_table_privilege(
        current_user,
        'public.sqs_inbox_messages',
        'DELETE'
      ) AS "inboxDelete",

      has_column_privilege(
        current_user,
        'public.wager_outbox_events',
        'payload',
        'UPDATE'
      ) AS "outboxPayloadUpdate",

      has_column_privilege(
        current_user,
        'public.wager_outbox_events',
        'event_id',
        'UPDATE'
      ) AS "outboxEventIdUpdate",

      has_column_privilege(
        current_user,
        'public.wager_outbox_events',
        'transaction_id',
        'UPDATE'
      ) AS "outboxTransactionUpdate",

      has_column_privilege(
        current_user,
        'public.wager_outbox_events',
        'published_at',
        'UPDATE'
      ) AS "outboxPublishUpdate",

      has_table_privilege(
        current_user,
        'public.wager_outbox_events',
        'DELETE'
      ) AS "outboxDelete"
    `,
      [],
      'get',
    );

    expect(permissions.inboxUpdate).toBe(false);
    expect(permissions.inboxDelete).toBe(false);

    expect(permissions.outboxPayloadUpdate).toBe(false);
    expect(permissions.outboxEventIdUpdate).toBe(false);
    expect(permissions.outboxTransactionUpdate).toBe(false);
    expect(permissions.outboxPublishUpdate).toBe(true);

    expect(permissions.outboxDelete).toBe(false);
  });
});
