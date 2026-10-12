import 'reflect-metadata';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

import { PostgresBetRepository } from '../src/infrastructure/persistence/postgres-bet.repository';

const POLL_INTERVAL_MS = 1_000;

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  const repository = new PostgresBetRepository(orm.em.fork());

  let stopping = false;

  process.once('SIGINT', () => {
    stopping = true;
  });

  process.once('SIGTERM', () => {
    stopping = true;
  });

  console.log('Reference worker started');

  try {
    while (!stopping) {
      try {
        const result = await repository.processNextPending();

        if (result === 'EMPTY') {
          await Bun.sleep(POLL_INTERVAL_MS);
          continue;
        }

        console.log(`[reference-worker] Result: ${result}`);
      } catch (error: unknown) {
        console.error('[reference-worker] Processing failure:', error);

        // Evita um loop intenso após uma falha de infraestrutura.
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
  } finally {
    await orm.close(true);
    console.log('Reference worker stopped');
  }
}

void main().catch((error: unknown) => {
  console.error('Reference worker failed:', error);
  process.exitCode = 1;
});
