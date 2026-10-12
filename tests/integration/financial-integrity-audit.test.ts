import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm } from './helpers/test-orm';

import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';

import { ProcessBetUseCase } from '../../src/application/wagering/process-bet.use-case';

import { ProcessOutcomeUseCase } from '../../src/application/wagering/process-outcome.use-case';

import { ProcessReversalUseCase } from '../../src/application/wagering/process-reversal.use-case';

import { PostgresWalletRepository } from '../../src/infrastructure/persistence/postgres-wallet.repository';

import { PostgresBetRepository } from '../../src/infrastructure/persistence/postgres-bet.repository';

import { runFinancialAudit } from '../../src/infrastructure/diagnostics/financial-integrity.audit';

describe('Financial integrity audit', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('should validate BET, WIN and REFUND financial invariants', async () => {
    const wallet = await new CreateWalletUseCase(
      new PostgresWalletRepository(orm.em.fork()),
    ).execute({
      playerId: `audit-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    const providerId = 'financial-audit-test';
    const betExternalId = randomUUID();

    const bet = await new ProcessBetUseCase(new PostgresBetRepository(orm.em.fork())).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: betExternalId,
      amount: '30.00',
      currency: 'BRL',
    });

    const win = await new ProcessOutcomeUseCase(new PostgresBetRepository(orm.em.fork())).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      type: 'WIN',
      amount: '20.00',
      currency: 'BRL',
    });

    const refund = await new ProcessReversalUseCase(
      new PostgresBetRepository(orm.em.fork()),
    ).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: betExternalId,
      type: 'REFUND',
      amount: '30.00',
      currency: 'BRL',
    });

    expect(bet.status).toBe('PROCESSED');
    expect(win.status).toBe('PROCESSED');
    expect(refund.status).toBe('PROCESSED');
    expect(refund.balanceAfter).toBe('120.00');

    const report = await runFinancialAudit(orm.em.fork(), wallet.id);

    expect(report.walletId).toBe(wallet.id);
    expect(report.consistent).toBe(true);

    for (const value of Object.values(report.metrics)) {
      expect(value).toBe(0);
    }
  });

  test('should validate rollback financial semantics', async () => {
    const wallet = await new CreateWalletUseCase(
      new PostgresWalletRepository(orm.em.fork()),
    ).execute({
      playerId: `audit-rollback-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '100.00',
    });

    const providerId = 'financial-audit-rollback';
    const winId = randomUUID();
    const lossId = randomUUID();
    await new ProcessBetUseCase(new PostgresBetRepository(orm.em.fork())).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      amount: '30.00',
      currency: 'BRL',
    });
    await new ProcessOutcomeUseCase(new PostgresBetRepository(orm.em.fork())).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: winId,
      type: 'WIN',
      amount: '50.00',
      currency: 'BRL',
    });
    const rollbackWin = await new ProcessReversalUseCase(
      new PostgresBetRepository(orm.em.fork()),
    ).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: winId,
      type: 'ROLLBACK',
      amount: '50.00',
      currency: 'BRL',
    });
    await new ProcessOutcomeUseCase(new PostgresBetRepository(orm.em.fork())).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: lossId,
      type: 'LOSS',
      amount: '30.00',
      currency: 'BRL',
    });
    const rollbackLoss = await new ProcessReversalUseCase(
      new PostgresBetRepository(orm.em.fork()),
    ).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: lossId,
      type: 'ROLLBACK',
      amount: '30.00',
      currency: 'BRL',
    });

    expect(rollbackWin.status).toBe('PROCESSED');
    expect(rollbackWin.balanceAfter).toBe('70.00');

    expect(rollbackLoss.status).toBe('PROCESSED');
    expect(rollbackLoss.balanceAfter).toBe('70.00');

    const report = await runFinancialAudit(orm.em.fork(), wallet.id);

    expect(report.consistent).toBe(true);
    expect(report.metrics.mismatchedLedgerSemantics).toBe(0);
    expect(report.metrics.invalidProcessedReversals).toBe(0);
    expect(report.metrics.invalidOpeningEntries).toBe(0);
  });

  test('should allow rejected and pending operations without ledger movements', async () => {
    const wallet = await new CreateWalletUseCase(
      new PostgresWalletRepository(orm.em.fork()),
    ).execute({
      playerId: `audit-pending-${randomUUID()}`,
      currency: 'BRL',
      openingBalance: '20.00',
    });

    const providerId = 'financial-audit-pending';
    const rejectedBet = await new ProcessBetUseCase(
      new PostgresBetRepository(orm.em.fork()),
    ).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      amount: '30.00',
      currency: 'BRL',
    });
    const pendingRefund = await new ProcessReversalUseCase(
      new PostgresBetRepository(orm.em.fork()),
    ).execute({
      walletId: wallet.id,
      providerId,
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: randomUUID(),
      type: 'REFUND',
      amount: '10.00',
      currency: 'BRL',
    });

    expect(rejectedBet.status).toBe('REJECTED');
    expect(rejectedBet.reason).toBe('INSUFFICIENT_FUNDS');

    expect(pendingRefund.status).toBe('PENDING_REFERENCE');

    const report = await runFinancialAudit(orm.em.fork(), wallet.id);

    expect(report.consistent).toBe(true);

    for (const value of Object.values(report.metrics)) {
      expect(value).toBe(0);
    }
  });
});
