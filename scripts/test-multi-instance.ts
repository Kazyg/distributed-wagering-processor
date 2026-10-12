import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

import { CreateWalletUseCase } from '../src/application/wallets/create-wallet.use-case';
import { ProcessBetUseCase } from '../src/application/wagering/process-bet.use-case';

import { PostgresWalletRepository } from '../src/infrastructure/persistence/postgres-wallet.repository';
import { PostgresBetRepository } from '../src/infrastructure/persistence/postgres-bet.repository';

import { runFinancialAudit } from '../src/infrastructure/diagnostics/financial-integrity.audit';

interface WorkerResult {
  instance: string;
  processId: number;
  postgresProcessId: number;
  attempted: number;
  processed: number;
  rejected: number;
  sharedTransactionId: string;
  sharedStatus: string;
}

interface FinancialCounts {
  total: number;
  processed: number;
  rejected: number;
}

interface LedgerCounts {
  total: number;
  debited: string;
}

const BETS_PER_INSTANCE = 40;
const OPENING_BALANCE = '50.00';
const BET_AMOUNT = '1.00';
const RESULT_PREFIX = 'MULTI_INSTANCE_RESULT:';

function assertTestMode(): void {
  if (process.env.NODE_ENV !== 'test' || process.env.DB_CONNECTION_MODE !== 'app') {
    throw new Error('Multi-instance test requires test/app mode');
  }
}

async function assertTestDatabase(orm: MikroORM): Promise<number> {
  const row = await orm.em.fork().execute<{
    databaseName: string;
    username: string;
    postgresProcessId: number;
  }>(
    `
    SELECT
      current_database() AS "databaseName",
      current_user AS "username",
      pg_backend_pid()::integer AS "postgresProcessId"
    `,
    [],
    'get',
  );

  assert.equal(row.databaseName, 'wagering_test');
  assert.equal(row.username, 'wagering_app');

  return row.postgresProcessId;
}

async function executeBet(
  orm: MikroORM,
  walletId: string,
  providerId: string,
  externalTransactionId: string,
) {
  const useCase = new ProcessBetUseCase(new PostgresBetRepository(orm.em.fork()));

  return useCase.execute({
    walletId,
    providerId,
    externalTransactionId,
    amount: BET_AMOUNT,
    currency: 'BRL',
  });
}

async function runWorker(args: string[]): Promise<void> {
  const [walletId, providerId, sharedId, startAtText, instance] = args;

  if (!walletId || !providerId || !sharedId || !startAtText || !instance) {
    throw new Error('Invalid worker arguments');
  }

  const startAt = Number(startAtText);

  if (!Number.isFinite(startAt)) {
    throw new Error('Invalid start time');
  }

  const orm = await MikroORM.init(config);

  try {
    const postgresProcessId = await assertTestDatabase(orm);

    const delay = Math.max(0, startAt - Date.now());

    if (delay > 0) {
      await Bun.sleep(delay);
    }

    const sharedResult = await executeBet(orm, walletId, providerId, sharedId);

    const results = await Promise.all(
      Array.from({ length: BETS_PER_INSTANCE }, (_, index) =>
        executeBet(orm, walletId, providerId, `${instance}-${index}-${randomUUID()}`),
      ),
    );

    const processed = results.filter((result) => result.status === 'PROCESSED').length;

    const rejected = results.filter((result) => result.status === 'REJECTED').length;

    assert.equal(processed + rejected, BETS_PER_INSTANCE);

    const output: WorkerResult = {
      instance,
      processId: process.pid,
      postgresProcessId,
      attempted: BETS_PER_INSTANCE + 1,
      processed: processed + Number(sharedResult.status === 'PROCESSED'),
      rejected: rejected + Number(sharedResult.status === 'REJECTED'),
      sharedTransactionId: sharedResult.transactionId,
      sharedStatus: sharedResult.status,
    };

    console.log(`${RESULT_PREFIX}${JSON.stringify(output)}`);
  } finally {
    await orm.close(true);
  }
}

async function spawnWorker(args: string[]): Promise<WorkerResult> {
  const child = Bun.spawn(
    [process.execPath, 'scripts/test-multi-instance.ts', '--worker', ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DB_CONNECTION_MODE: 'app',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Instance failed with code ${exitCode}\n${stdout}\n${stderr}`);
  }

  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));

  if (!resultLine) {
    throw new Error(`Missing worker result:\n${stdout}\n${stderr}`);
  }

  return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as WorkerResult;
}

async function runParent(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    await assertTestDatabase(orm);

    const wallet = await new CreateWalletUseCase(
      new PostgresWalletRepository(orm.em.fork()),
    ).execute({
      playerId: `multi-instance-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: OPENING_BALANCE,
    });

    const providerId = `multi-instance-${randomUUID()}`;
    const sharedId = `shared-${randomUUID()}`;
    const startAt = Date.now() + 4000;

    console.log('[multi-instance] Starting two independent processes');
    console.log('[multi-instance] Wallet:', wallet.id);

    const started = performance.now();

    const workers = await Promise.all([
      spawnWorker([wallet.id, providerId, sharedId, String(startAt), 'instance-a']),
      spawnWorker([wallet.id, providerId, sharedId, String(startAt), 'instance-b']),
    ]);

    const elapsedMs = Math.round(performance.now() - started);

    assert.notEqual(workers[0]?.processId, workers[1]?.processId);
    assert.notEqual(workers[0]?.postgresProcessId, workers[1]?.postgresProcessId);

    assert.equal(workers[0]?.sharedTransactionId, workers[1]?.sharedTransactionId);

    assert.equal(workers[0]?.sharedStatus, 'PROCESSED');
    assert.equal(workers[1]?.sharedStatus, 'PROCESSED');

    const em = orm.em.fork();

    const walletRow = await em.execute<{ balance: string }>(
      `
      SELECT balance::text AS "balance"
      FROM public.wallets
      WHERE id = ?::uuid
      `,
      [wallet.id],
      'get',
    );

    const financial = await em.execute<FinancialCounts>(
      `
      SELECT
        COUNT(*)::integer AS "total",
        COUNT(*) FILTER (
          WHERE status = 'PROCESSED'
        )::integer AS "processed",
        COUNT(*) FILTER (
          WHERE status = 'REJECTED'
        )::integer AS "rejected"
      FROM public.wager_transactions
      WHERE wallet_id = ?::uuid
        AND provider_id = ?
        AND type = 'BET'
      `,
      [wallet.id, providerId],
      'get',
    );

    const ledger = await em.execute<LedgerCounts>(
      `
      SELECT
        COUNT(*)::integer AS "total",
        COALESCE(SUM(amount), 0)::text AS "debited"
      FROM public.wallet_ledger_entries
      WHERE wallet_id = ?::uuid
        AND operation = 'BET'
      `,
      [wallet.id],
      'get',
    );

    const sharedRows = await em.execute<{ total: number }>(
      `
      SELECT COUNT(*)::integer AS "total"
      FROM public.wager_transactions
      WHERE wallet_id = ?::uuid
        AND provider_id = ?
        AND external_transaction_id = ?
      `,
      [wallet.id, providerId, sharedId],
      'get',
    );

    const audit = await runFinancialAudit(orm.em.fork(), wallet.id);

    const attempts = workers.reduce((sum, worker) => sum + worker.attempted, 0);

    assert.equal(attempts, 82);
    assert.equal(financial.total, 81);
    assert.equal(financial.processed, 50);
    assert.equal(financial.rejected, 31);
    assert.equal(sharedRows.total, 1);
    assert.equal(ledger.total, 50);
    assert.equal(ledger.debited, '50.00');
    assert.equal(walletRow.balance, '0.00');
    assert.equal(audit.consistent, true);

    console.log(
      JSON.stringify(
        {
          scenario: 'two-independent-processes-one-hot-wallet',
          walletId: wallet.id,
          instances: workers,
          attempts,
          uniqueTransactions: financial.total,
          processed: financial.processed,
          rejected: financial.rejected,
          duplicateSharedKeyRows: sharedRows.total,
          ledgerDebits: ledger.total,
          totalDebited: ledger.debited,
          finalBalance: walletRow.balance,
          auditConsistent: audit.consistent,
          elapsedMs,
        },
        null,
        2,
      ),
    );

    console.log('[multi-instance] ALL CHECKS PASSED');
  } finally {
    await orm.close(true);
  }
}

async function main(): Promise<void> {
  assertTestMode();

  const workerPosition = process.argv.indexOf('--worker');

  if (workerPosition >= 0) {
    await runWorker(process.argv.slice(workerPosition + 1));
  } else {
    await runParent();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
