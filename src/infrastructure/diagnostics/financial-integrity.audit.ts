import type { EntityManager } from '@mikro-orm/postgresql';

export interface FinancialAuditMetrics {
  incorrectLedgerArithmetic: number;
  mismatchedWalletBalances: number;
  invalidLedgerReferences: number;
  duplicateLedgerMovements: number;
  missingFinancialMovements: number;
  unexpectedFinancialMovements: number;
  mismatchedLedgerSemantics: number;
  invalidProcessedReversals: number;
  invalidOpeningEntries: number;
}

export interface FinancialAuditReport {
  checkedAt: string;
  walletId: string | null;
  metrics: FinancialAuditMetrics;
  consistent: boolean;
}

async function countFindings(tx: EntityManager, sql: string, walletId?: string): Promise<number> {
  const row = await tx.execute<{ total: number }>(sql, [walletId ?? null, walletId ?? null], 'get');

  if (!row) {
    throw new Error('Financial audit query returned no result');
  }

  return Number(row.total);
}

export async function runFinancialAudit(
  em: EntityManager,
  walletId?: string,
): Promise<FinancialAuditReport> {
  return em.fork().transactional(async (tx) => {
    // Todas as consultas usam o mesmo snapshot.
    // Essa transação não pode modificar dados.
    await tx.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

    // 1. Verifica cada lançamento individualmente.
    const incorrectLedgerArithmetic = await countFindings(
      tx,
      `
      SELECT COUNT(*)::integer AS "total"
      FROM public.wallet_ledger_entries l
      WHERE (?::uuid IS NULL OR l.wallet_id = ?::uuid)
        AND (
          l.direction IS NULL
          OR l.direction NOT IN ('CREDIT', 'DEBIT')
          OR l.amount IS NULL
          OR l.amount <= 0
          OR l.balance_before IS NULL
          OR l.balance_after IS NULL
          OR l.balance_before < 0
          OR l.balance_after < 0
          OR l.balance_after IS DISTINCT FROM (
            CASE l.direction
              WHEN 'CREDIT'
                THEN l.balance_before + l.amount
              WHEN 'DEBIT'
                THEN l.balance_before - l.amount
            END
          )
        )
      `,
      walletId,
    );

    // 2. Confere saldo armazenado versus soma do ledger.
    const mismatchedWalletBalances = await countFindings(
      tx,
      `
      SELECT COUNT(*)::integer AS "total"
      FROM public.wallets w
      WHERE (?::uuid IS NULL OR w.id = ?::uuid)
        AND w.balance IS DISTINCT FROM (
          SELECT COALESCE(
            SUM(
              CASE l.direction
                WHEN 'CREDIT' THEN l.amount
                WHEN 'DEBIT' THEN -l.amount
                ELSE 0
              END
            ),
            0
          )
          FROM public.wallet_ledger_entries l
          WHERE l.wallet_id = w.id
        )
      `,
      walletId,
    );

    // 3. Detecta lançamentos sem transação válida.
    const invalidLedgerReferences = await countFindings(
      tx,
      `
      SELECT COUNT(*)::integer AS "total"
      FROM public.wallet_ledger_entries l
      LEFT JOIN public.wager_transactions t
        ON t.id = l.transaction_id
      WHERE (?::uuid IS NULL OR l.wallet_id = ?::uuid)
        AND (
          (
            l.operation <> 'OPENING'
            AND l.transaction_id IS NULL
          )
          OR (
            l.transaction_id IS NOT NULL
            AND (
              t.id IS NULL
              OR t.wallet_id IS DISTINCT FROM l.wallet_id
            )
          )
        )
      `,
      walletId,
    );

    // 4. Uma transação não pode produzir dois
    // lançamentos financeiros no modelo atual.
    const duplicateLedgerMovements = await countFindings(
      tx,
      `
      SELECT COUNT(*)::integer AS "total"
      FROM (
        SELECT l.transaction_id
        FROM public.wallet_ledger_entries l
        WHERE (?::uuid IS NULL OR l.wallet_id = ?::uuid)
          AND l.transaction_id IS NOT NULL
        GROUP BY l.transaction_id
        HAVING COUNT(*) > 1
      ) duplicated
      `,
      walletId,
    );

    // 5. Transações processadas com efeito financeiro
    // devem ter seu lançamento correspondente.
    const missingFinancialMovements = await countFindings(
      tx,
      `
      SELECT COUNT(*)::integer AS "total"
      FROM public.wager_transactions t
      LEFT JOIN public.wager_transactions original
        ON original.id = t.reference_transaction_id
      WHERE (?::uuid IS NULL OR t.wallet_id = ?::uuid)
        AND t.status = 'PROCESSED'
        AND (
          t.type IN ('BET', 'WIN', 'REFUND')
          OR (
            t.type = 'ROLLBACK'
            AND original.type IN ('BET', 'WIN')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.wallet_ledger_entries l
          WHERE l.transaction_id = t.id
        )
      `,
      walletId,
    );

    // 6. Resultados sem efeito financeiro não devem
    // possuir lançamentos associados.
    const unexpectedFinancialMovements = await countFindings(
      tx,
      `
      SELECT COUNT(*)::integer AS "total"
      FROM public.wager_transactions t
      LEFT JOIN public.wager_transactions original
        ON original.id = t.reference_transaction_id
      WHERE (?::uuid IS NULL OR t.wallet_id = ?::uuid)
        AND (
          t.status <> 'PROCESSED'
          OR t.type = 'LOSS'
          OR (
            t.type = 'ROLLBACK'
            AND original.type = 'LOSS'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM public.wallet_ledger_entries l
          WHERE l.transaction_id = t.id
        )
      `,
      walletId,
    );

    const mismatchedLedgerSemantics = await countFindings(
      tx,
      `
        SELECT COUNT(*)::integer AS "total"
        FROM public.wallet_ledger_entries l

        LEFT JOIN public.wager_transactions t
            ON t.id = l.transaction_id

        LEFT JOIN public.wager_transactions original
            ON original.id = t.reference_transaction_id

        WHERE (?::uuid IS NULL OR l.wallet_id = ?::uuid)
            AND l.operation <> 'OPENING'
            AND (
            t.id IS NULL
            OR t.status IS DISTINCT FROM 'PROCESSED'
            OR t.wallet_id IS DISTINCT FROM l.wallet_id
            OR t.amount IS DISTINCT FROM l.amount
            OR NOT (
                (
                t.type = 'BET'
                AND l.operation = 'BET'
                AND l.direction = 'DEBIT'
                )
                OR (
                t.type = 'WIN'
                AND l.operation = 'WIN'
                AND l.direction = 'CREDIT'
                )
                OR (
                t.type = 'REFUND'
                AND l.operation = 'REFUND'
                AND l.direction = 'CREDIT'
                )
                OR (
                t.type = 'ROLLBACK'
                AND l.operation = 'ROLLBACK'
                AND (
                    (
                     original.type = 'BET'
                     AND l.direction = 'CREDIT'
                   )
                    OR (
                      original.type = 'WIN'
                      AND l.direction = 'DEBIT'
                  )
                 )
               )
              )
            )
        `,
      walletId,
    );

    const invalidProcessedReversals = await countFindings(
      tx,
      `
        SELECT COUNT(*)::integer AS "total"
        FROM public.wager_transactions t

        LEFT JOIN public.wager_transactions original
            ON original.id = t.reference_transaction_id

        WHERE (?::uuid IS NULL OR t.wallet_id = ?::uuid)
            AND t.status = 'PROCESSED'
            AND t.type IN ('REFUND', 'ROLLBACK')
            AND (
            original.id IS NULL

            OR original.status IS DISTINCT FROM 'PROCESSED'

            OR original.type NOT IN ('BET', 'WIN', 'LOSS')

            OR (
                t.type = 'REFUND'
                AND original.type IS DISTINCT FROM 'BET'
            )

            OR t.wallet_id IS DISTINCT FROM original.wallet_id

            OR t.provider_id IS DISTINCT FROM original.provider_id

            OR t.currency IS DISTINCT FROM original.currency

            OR t.amount IS DISTINCT FROM original.amount

            OR t.reference_external_transaction_id
                IS DISTINCT FROM original.external_transaction_id
            )
        `,
      walletId,
    );

    const invalidOpeningEntries = await countFindings(
      tx,
      `
        SELECT COUNT(*)::integer AS "total"
        FROM public.wallet_ledger_entries l
        WHERE (?::uuid IS NULL OR l.wallet_id = ?::uuid)
            AND l.operation = 'OPENING'
            AND (
            l.transaction_id IS NOT NULL
            OR l.direction IS DISTINCT FROM 'CREDIT'
            OR l.balance_before IS DISTINCT FROM 0
            OR l.balance_after IS DISTINCT FROM l.amount
            )
        `,
      walletId,
    );

    const metrics: FinancialAuditMetrics = {
      incorrectLedgerArithmetic,
      mismatchedWalletBalances,
      invalidLedgerReferences,
      duplicateLedgerMovements,
      missingFinancialMovements,
      unexpectedFinancialMovements,
      mismatchedLedgerSemantics,
      invalidProcessedReversals,
      invalidOpeningEntries,
    };

    return {
      checkedAt: new Date().toISOString(),
      walletId: walletId ?? null,
      metrics,
      consistent: Object.values(metrics).every((value) => value === 0),
    };
  });
}
