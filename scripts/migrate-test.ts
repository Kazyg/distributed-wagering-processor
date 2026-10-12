import 'reflect-metadata';

import { createTestOrm } from '../tests/integration/helpers/test-orm';

async function main(): Promise<void> {
  const orm = await createTestOrm();

  try {
    const migrations = await orm.migrator.up();

    console.log(`Test database ready. Applied ${migrations.length} migration(s).`);
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
