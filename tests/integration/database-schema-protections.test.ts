import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

interface ProtectionStatus {
  ledgerProtected: boolean;
  wagerStatusProtected: boolean;
}

describe('Database schema protections', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('should keep financial protection triggers enabled', async () => {
    const status = await orm.em.fork().execute<ProtectionStatus>(
      `
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid =
            'public.wallet_ledger_entries'::regclass
            AND tgname = 'trg_wallet_ledger_immutable'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS "ledgerProtected",

        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid =
            'public.wager_transactions'::regclass
            AND tgname = 'trg_wager_status_guard'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS "wagerStatusProtected"
      `,
      [],
      'get',
    );

    expect(status.ledgerProtected).toBe(true);
    expect(status.wagerStatusProtected).toBe(true);
  });
});
