import 'dotenv/config';

import { Client } from 'pg';

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

async function main(): Promise<void> {
  const host = process.env.POSTGRES_HOST ?? '127.0.0.1';
  const port = Number(process.env.POSTGRES_PORT ?? '5432');

  const dbName = requiredEnv('POSTGRES_DB');
  const adminUser = requiredEnv('POSTGRES_USER');
  const adminPassword = requiredEnv('POSTGRES_PASSWORD');

  const appUser = requiredEnv('POSTGRES_APP_USER');
  const appPassword = requiredEnv('POSTGRES_APP_PASSWORD');

  if (appUser === adminUser) {
    throw new Error('Application and admin roles must be different');
  }

  if (!/^[a-z_][a-z0-9_]*$/.test(appUser)) {
    throw new Error('Invalid application role name');
  }

  // Evita aplicar permissões no banco errado.
  const isTest = process.env.NODE_ENV === 'test';

  const expectedDatabase = isTest ? 'wagering_test' : 'wagering_db';

  const expectedPort = isTest ? 5433 : 5432;

  if (host !== '127.0.0.1' || port !== expectedPort || dbName !== expectedDatabase) {
    throw new Error('Unexpected database configuration');
  }

  const client = new Client({
    host,
    port,
    database: dbName,
    user: adminUser,
    password: adminPassword,
  });

  const role = `"${appUser.replaceAll('"', '""')}"`;

  try {
    await client.connect();

    const existing = await client.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = $1
      ) AS "exists"
      `,
      [appUser],
    );

    if (!existing.rows[0]?.exists) {
      await client.query(`
        CREATE ROLE ${role}
        LOGIN
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOREPLICATION
        NOINHERIT
      `);
    }

    // O PostgreSQL faz o escape seguro da senha.
    const escaped = await client.query<{ literal: string }>(
      'SELECT quote_literal($1::text) AS literal',
      [appPassword],
    );

    const passwordLiteral = escaped.rows[0]?.literal;

    if (!passwordLiteral) {
      throw new Error('Could not prepare application password');
    }

    await client.query(`
      ALTER ROLE ${role}
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOINHERIT
      PASSWORD ${passwordLiteral}
    `);

    await client.query(`
      GRANT CONNECT ON DATABASE "${dbName}" TO ${role}
    `);

    await client.query(`
      GRANT USAGE ON SCHEMA public TO ${role}
    `);

    await client.query(`
      REVOKE CREATE ON SCHEMA public FROM ${role}
    `);

    // Remove permissões explícitas antigas antes de reaplicar.
    await client.query(`
      REVOKE ALL ON TABLE
        public.wallets,
        public.wallet_ledger_entries,
        public.wager_transactions,
        public.sqs_inbox_messages,
        public.wager_outbox_events
      FROM ${role}
    `);

    // Leitura e inserção nas três tabelas financeiras.
    await client.query(`
      GRANT SELECT, INSERT ON TABLE
        public.wallets,
        public.wallet_ledger_entries,
        public.wager_transactions
      TO ${role}
    `);

    // UPDATE limitado às colunas necessárias da carteira.
    await client.query(`
      GRANT UPDATE (balance, version, updated_at)
      ON TABLE public.wallets
      TO ${role}
    `);

    await client.query(`
        GRANT UPDATE (
            status,
            reason,
            balance_after,
            reference_transaction_id,
            retry_count,
            next_retry_at
        )
        ON TABLE public.wager_transactions
        TO ${role}
    `);

    await client.query(`
      GRANT SELECT, INSERT
      ON TABLE public.sqs_inbox_messages
      TO ${role}
    `);

    await client.query(`
      GRANT SELECT, INSERT
      ON TABLE public.wager_outbox_events
      TO ${role}
    `);

    await client.query(`
      GRANT UPDATE (
        published_at,
        attempt_count,
        next_attempt_at,
        claim_token,
        claimed_until,
        last_error
      )
      ON TABLE public.wager_outbox_events
      TO ${role}
    `);

    await client.query(`
      GRANT USAGE, SELECT
      ON SEQUENCE public.wager_outbox_events_id_seq
      TO ${role}
    `);

    // Confirma que a conta não pode modificar o ledger.
    const permissions = await client.query<{
      canUpdateLedger: boolean;
      canDeleteLedger: boolean;
      canTruncateLedger: boolean;
      canCreateObjects: boolean;
    }>(
      `
      SELECT
        has_table_privilege(
          $1, 'public.wallet_ledger_entries', 'UPDATE'
        ) AS "canUpdateLedger",
        has_table_privilege(
          $1, 'public.wallet_ledger_entries', 'DELETE'
        ) AS "canDeleteLedger",
        has_table_privilege(
          $1, 'public.wallet_ledger_entries', 'TRUNCATE'
        ) AS "canTruncateLedger",
        has_schema_privilege(
          $1, 'public', 'CREATE'
        ) AS "canCreateObjects"
      `,
      [appUser],
    );

    const result = permissions.rows[0];

    if (
      !result ||
      result.canUpdateLedger ||
      result.canDeleteLedger ||
      result.canTruncateLedger ||
      result.canCreateObjects
    ) {
      throw new Error('Application role has excessive privileges');
    }

    console.log(`Application role "${appUser}" configured for ${dbName}`);
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
