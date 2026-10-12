import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../../src/infrastructure/database/mikro-orm.config';

export function assertTestDatabase(): void {
  const isTestEnvironment = process.env.NODE_ENV === 'test';

  const isTestDatabase =
    config.dbName === 'wagering_test' && config.host === '127.0.0.1' && config.port === 5433;

  if (!isTestEnvironment || !isTestDatabase) {
    throw new Error('Integration tests must use the isolated wagering_test database on port 5433');
  }
}

export async function createTestOrm(): Promise<MikroORM> {
  assertTestDatabase();

  return MikroORM.init(config);
}
