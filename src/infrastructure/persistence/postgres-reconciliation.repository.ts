import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import type {
  WalletReconciliationReader,
  WalletReconciliationReport,
} from '../../application/reconciliation/reconcile-wallet.use-case';

@Injectable()
export class PostgresReconciliationRepository implements WalletReconciliationReader {
  constructor(private readonly em: EntityManager) {}

  async getReport(walletId: string): Promise<WalletReconciliationReport | null> {
    const report = await this.em.fork().execute<WalletReconciliationReport>(
      `
      SELECT
        w.id AS "walletId",
        w.currency AS "currency",
        w.balance::text AS "storedBalance",

        COALESCE(
          summary.ledger_total,
          0
        )::numeric(38, 2)::text AS "ledgerBalance",

        (
          w.balance - COALESCE(summary.ledger_total, 0)
        )::numeric(38, 2)::text AS "difference",

        summary.entry_count::integer AS "entryCount",

        (
          w.balance = COALESCE(summary.ledger_total, 0)
        ) AS "consistent"

      FROM wallets AS w

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS entry_count,

          SUM(
            CASE
              WHEN l.direction = 'CREDIT'
                THEN l.amount
              WHEN l.direction = 'DEBIT'
                THEN -l.amount
              ELSE 0
            END
          ) AS ledger_total

        FROM wallet_ledger_entries AS l
        WHERE l.wallet_id = w.id
      ) AS summary ON TRUE

      WHERE w.id = ?
      `,
      [walletId],
      'get',
    );

    return report ?? null;
  }
}
