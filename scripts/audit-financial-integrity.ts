import 'reflect-metadata';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

import { runFinancialAudit } from '../src/infrastructure/diagnostics/financial-integrity.audit';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  if (process.env.DB_CONNECTION_MODE === 'admin') {
    throw new Error('Financial audit must use application role');
  }

  const walletArgument = process.argv.find((value) => value.startsWith('--wallet='));

  const walletId = walletArgument?.slice('--wallet='.length);

  if (walletId && !UUID_PATTERN.test(walletId)) {
    throw new Error('Invalid wallet ID');
  }

  const orm = await MikroORM.init(config);

  try {
    const connection = await orm.em.fork().execute<{
      databaseName: string;
      username: string;
    }>(
      `
      SELECT
        current_database() AS "databaseName",
        current_user AS "username"
      `,
      [],
      'get',
    );

    const expectedDatabase = process.env.NODE_ENV === 'test' ? 'wagering_test' : 'wagering_db';

    if (
      connection.databaseName !== expectedDatabase ||
      connection.username !== process.env.POSTGRES_APP_USER
    ) {
      throw new Error('Unexpected database or database role');
    }

    const report = await runFinancialAudit(orm.em.fork(), walletId);

    console.log(
      JSON.stringify(
        {
          database: connection.databaseName,
          ...report,
        },
        null,
        2,
      ),
    );

    if (!report.consistent) {
      console.error('[financial-audit] Integrity findings detected');

      process.exitCode = 1;
    }
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
