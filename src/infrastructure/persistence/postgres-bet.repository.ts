import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  referenceRetryDelayMs,
  MAX_REFERENCE_ATTEMPTS,
} from '../../application/wagering/reference-retry-policy';

import {
  IdempotencyConflictError,
  InvalidBetError,
  type BetPersistence,
  type ProcessBetInput,
  type ProcessBetOutput,
  WalletNotFoundError,
} from '../../application/wagering/process-bet.use-case';

import type {
  OutcomePersistence,
  ProcessOutcomeInput,
} from '../../application/wagering/process-outcome.use-case';

import {
  InvalidReversalError,
  ReferenceAlreadyReversedError,
  ReferenceNotFoundError,
  type ProcessReversalInput,
  type ReversalPersistence,
} from '../../application/wagering/process-reversal.use-case';

import { Money } from '../../domain/money/money';
import { InsufficientFundsError, Wallet, type WalletMovement } from '../../domain/wallet/wallet';

import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { enqueueWagerResult } from './enqueue-wager-result';

type WagerInput = (ProcessBetInput & { type: 'BET' }) | ProcessOutcomeInput | ProcessReversalInput;

export type PendingProcessingResult = 'EMPTY' | 'RETRIED' | 'PROCESSED' | 'REJECTED';

@Injectable()
export class PostgresBetRepository
  implements BetPersistence, OutcomePersistence, ReversalPersistence
{
  constructor(private readonly em: EntityManager) {}

  processBet(input: ProcessBetInput): Promise<ProcessBetOutput> {
    return this.process({ ...input, type: 'BET' });
  }

  processOutcome(input: ProcessOutcomeInput): Promise<ProcessBetOutput> {
    return this.process(input);
  }

  processReversal(input: ProcessReversalInput): Promise<ProcessBetOutput> {
    return this.process(input);
  }

  forTransaction(tx: EntityManager): BetPersistence & OutcomePersistence & ReversalPersistence {
    return {
      processBet: (input) =>
        this.processInTransaction(tx, {
          ...input,
          type: 'BET',
        }),

      processOutcome: (input) => this.processInTransaction(tx, input),

      processReversal: (input) => this.processInTransaction(tx, input),
    };
  }

  private async process(input: WagerInput): Promise<ProcessBetOutput> {
    const key = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    };

    try {
      return await this.em.fork().transactional((tx) => this.processInTransaction(tx, input));
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await this.em.fork().findOne(WagerTransactionEntity, key);

        if (existing) {
          return this.replay(existing, input);
        }
      }

      throw error;
    }
  }

  private async processInTransaction(
    tx: EntityManager,
    input: WagerInput,
  ): Promise<ProcessBetOutput> {
    const key = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    };

    // 1. Primeira verificação de idempotência.
    const previous = await tx.findOne(WagerTransactionEntity, key);

    if (previous) {
      return this.replay(previous, input);
    }

    // 2. Bloqueia a carteira durante o processamento.
    const walletEntity = await tx.findOne(
      WalletEntity,
      { id: input.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!walletEntity) {
      throw new WalletNotFoundError();
    }

    // 3. Reconsulta a chave após adquirir o lock.
    const existing = await tx.findOne(WagerTransactionEntity, key);

    if (existing) {
      return this.replay(existing, input);
    }

    if (walletEntity.currency !== input.currency) {
      throw new InvalidBetError('Wallet currency mismatch');
    }

    // 4. Restaura o domínio da carteira.
    const wallet = Wallet.restore({
      id: walletEntity.id,
      playerId: walletEntity.playerId,
      balance: Money.from(walletEntity.balance, walletEntity.currency),
    });

    const amount = Money.from(input.amount, input.currency);

    // 5. Prepara o registro da transação.
    const wager = new WagerTransactionEntity();

    wager.wallet = walletEntity;
    wager.providerId = input.providerId;
    wager.externalTransactionId = input.externalTransactionId;
    wager.type = input.type;
    wager.amount = amount.toString();
    wager.currency = input.currency;

    let movement: WalletMovement | null = null;
    let original: WagerTransactionEntity | null = null;

    // 6. Resolve referências para REFUND e ROLLBACK.
    if (input.type === 'REFUND' || input.type === 'ROLLBACK') {
      wager.referenceExternalTransactionId = input.referenceExternalTransactionId;

      try {
        original = await this.resolveReference(tx, walletEntity, input);
      } catch (error: unknown) {
        if (!(error instanceof ReferenceNotFoundError)) {
          throw error;
        }

        // A transação original ainda não chegou.
        // Registra a reversão como pendente.
        wager.status = 'PENDING_REFERENCE';
        wager.reason = null;
        wager.balanceAfter = walletEntity.balance;
        wager.retryCount = 0;
        wager.nextRetryAt = new Date();

        tx.persist(wager);

        return this.toOutput(wager);
      }

      wager.referenceTransaction = original;
    }

    // 7. Executa a movimentação financeira.
    try {
      switch (input.type) {
        case 'BET':
          movement = wallet.debit({
            entryId: randomUUID(),
            transactionId: wager.id,
            operation: 'BET',
            amount,
          });
          break;

        case 'WIN':
          movement = wallet.credit({
            entryId: randomUUID(),
            transactionId: wager.id,
            operation: 'WIN',
            amount,
          });
          break;

        case 'LOSS':
          // LOSS não movimenta saldo.
          break;

        case 'REFUND':
          movement = wallet.credit({
            entryId: randomUUID(),
            transactionId: wager.id,
            operation: 'REFUND',
            amount,
          });
          break;

        case 'ROLLBACK':
          if (!original) {
            throw new Error('Missing validated reference');
          }

          if (original.type === 'BET') {
            movement = wallet.credit({
              entryId: randomUUID(),
              transactionId: wager.id,
              operation: 'ROLLBACK',
              amount,
            });
          } else if (original.type === 'WIN') {
            movement = wallet.debit({
              entryId: randomUUID(),
              transactionId: wager.id,
              operation: 'ROLLBACK',
              amount,
            });
          }

          // ROLLBACK de LOSS não movimenta saldo.
          break;
      }
    } catch (error: unknown) {
      if (
        !(error instanceof InsufficientFundsError) ||
        (input.type !== 'BET' && input.type !== 'ROLLBACK')
      ) {
        throw error;
      }

      wager.status = 'REJECTED';
      wager.reason = 'INSUFFICIENT_FUNDS';
    }

    // 8. Atualiza o saldo quando houve movimentação.
    if (movement) {
      walletEntity.balance = movement.wallet.balance.toString();
    }

    if (wager.status !== 'REJECTED') {
      wager.status = 'PROCESSED';
    }

    wager.balanceAfter = walletEntity.balance;

    // 9. Persiste a transação financeira.
    tx.persist(wager);

    // Flush intermediário dentro da mesma transação SQL.
    // Não executa COMMIT.
    await tx.flush();

    // 10. Registra a movimentação no ledger.
    if (movement) {
      const entry = new WalletLedgerEntryEntity();

      entry.id = movement.entry.id;
      entry.wallet = walletEntity;
      entry.transactionId = wager.id;
      entry.operation = movement.entry.operation;
      entry.direction = movement.entry.direction;
      entry.amount = movement.entry.amount.toString();
      entry.balanceBefore = movement.entry.balanceBefore.toString();
      entry.balanceAfter = movement.entry.balanceAfter.toString();
      entry.occurredAt = new Date(movement.entry.occurredAt);

      tx.persist(entry);
    }
    enqueueWagerResult(tx, wager);
    // 11. Retorna o resultado.
    return this.toOutput(wager);
  }

  async processNextPending(targetTransactionId?: string): Promise<PendingProcessingResult> {
    return this.em.fork().transactional(async (tx) => {
      // Seleciona e bloqueia uma pendência disponível.
      // O filtro por UUID é útil nos testes de integração.
      const rows = await tx.execute<{ id: string }[]>(
        `
      SELECT id
      FROM public.wager_transactions
      WHERE status = 'PENDING_REFERENCE'
        AND next_retry_at <= NOW()
        AND (?::uuid IS NULL OR id = ?::uuid)
      ORDER BY next_retry_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
      `,
        [targetTransactionId ?? null, targetTransactionId ?? null],
      );

      const selectedId = rows[0]?.id;

      if (!selectedId) {
        return 'EMPTY';
      }

      const pending = await tx.findOneOrFail(WagerTransactionEntity, { id: selectedId });

      // Depois da pendência, bloqueia a carteira.
      const walletEntity = await tx.findOneOrFail(
        WalletEntity,
        { id: pending.wallet.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (pending.type !== 'REFUND' && pending.type !== 'ROLLBACK') {
        throw new Error('Invalid pending transaction type');
      }

      if (!pending.referenceExternalTransactionId) {
        throw new Error('Pending reference ID is missing');
      }

      const input: ProcessReversalInput = {
        walletId: walletEntity.id,
        providerId: pending.providerId,
        externalTransactionId: pending.externalTransactionId,
        referenceExternalTransactionId: pending.referenceExternalTransactionId,
        type: pending.type,
        amount: pending.amount,
        currency: pending.currency,
      };

      let original: WagerTransactionEntity;

      try {
        original = await this.resolveReference(tx, walletEntity, input);
      } catch (error: unknown) {
        if (error instanceof ReferenceNotFoundError) {
          pending.retryCount += 1;

          if (pending.retryCount >= MAX_REFERENCE_ATTEMPTS) {
            pending.status = 'REJECTED';
            pending.reason = 'REFERENCE_NOT_FOUND';
            pending.nextRetryAt = null;
            enqueueWagerResult(tx, pending);
            return 'REJECTED';
          }

          const delay = referenceRetryDelayMs(pending.retryCount);

          pending.nextRetryAt = new Date(Date.now() + delay);

          return 'RETRIED';
        }

        if (error instanceof InvalidReversalError) {
          pending.status = 'REJECTED';
          pending.reason = 'INVALID_REFERENCE';
          pending.nextRetryAt = null;
          enqueueWagerResult(tx, pending);
          return 'REJECTED';
        }

        if (error instanceof ReferenceAlreadyReversedError) {
          pending.status = 'REJECTED';
          pending.reason = 'REFERENCE_ALREADY_REVERSED';
          pending.nextRetryAt = null;
          enqueueWagerResult(tx, pending);
          return 'REJECTED';
        }

        // Falhas de infraestrutura não são convertidas
        // em rejeições financeiras.
        throw error;
      }

      const wallet = Wallet.restore({
        id: walletEntity.id,
        playerId: walletEntity.playerId,
        balance: Money.from(walletEntity.balance, walletEntity.currency),
      });

      const amount = Money.from(pending.amount, pending.currency);

      let movement: WalletMovement | null = null;

      try {
        if (pending.type === 'REFUND') {
          movement = wallet.credit({
            entryId: randomUUID(),
            transactionId: pending.id,
            operation: 'REFUND',
            amount,
          });
        } else if (original.type === 'WIN') {
          movement = wallet.debit({
            entryId: randomUUID(),
            transactionId: pending.id,
            operation: 'ROLLBACK',
            amount,
          });
        } else if (original.type === 'BET') {
          movement = wallet.credit({
            entryId: randomUUID(),
            transactionId: pending.id,
            operation: 'ROLLBACK',
            amount,
          });
        }
        // ROLLBACK de LOSS não movimenta saldo.
      } catch (error: unknown) {
        if (!(error instanceof InsufficientFundsError)) {
          throw error;
        }

        pending.status = 'REJECTED';
        pending.reason = 'INSUFFICIENT_FUNDS';
        pending.nextRetryAt = null;
        enqueueWagerResult(tx, pending);
        return 'REJECTED';
      }

      pending.referenceTransaction = original;
      pending.status = 'PROCESSED';
      pending.reason = null;
      pending.nextRetryAt = null;
      pending.retryCount += 1;

      if (movement) {
        walletEntity.balance = movement.wallet.balance.toString();

        const entry = new WalletLedgerEntryEntity();

        entry.id = movement.entry.id;
        entry.wallet = walletEntity;
        entry.transactionId = pending.id;
        entry.operation = movement.entry.operation;
        entry.direction = movement.entry.direction;
        entry.amount = movement.entry.amount.toString();
        entry.balanceBefore = movement.entry.balanceBefore.toString();
        entry.balanceAfter = movement.entry.balanceAfter.toString();
        entry.occurredAt = new Date(movement.entry.occurredAt);

        tx.persist(entry);
      }

      pending.balanceAfter = walletEntity.balance;
      enqueueWagerResult(tx, pending);
      return 'PROCESSED';
    });
  }

  private async resolveReference(
    tx: EntityManager,
    wallet: WalletEntity,
    input: ProcessReversalInput,
  ): Promise<WagerTransactionEntity> {
    // O identificador externo pertence ao namespace do provedor.
    const original = await tx.findOne(WagerTransactionEntity, {
      providerId: input.providerId,
      externalTransactionId: input.referenceExternalTransactionId,
    });

    if (!original) {
      throw new ReferenceNotFoundError();
    }

    if (original.wallet.id !== wallet.id || original.currency !== input.currency) {
      throw new InvalidReversalError(
        'Referenced transaction belongs to another wallet or currency',
      );
    }

    if (original.status !== 'PROCESSED') {
      throw new InvalidReversalError('Only processed transactions can be reversed');
    }

    if (original.type !== 'BET' && original.type !== 'WIN' && original.type !== 'LOSS') {
      throw new InvalidReversalError('Cannot reverse another reversal');
    }

    if (input.type === 'REFUND' && original.type !== 'BET') {
      throw new InvalidReversalError('REFUND must reference a processed BET');
    }

    if (original.amount !== input.amount) {
      throw new InvalidReversalError('Reversal amount must equal the original amount');
    }

    // Impede duas reversões financeiras processadas
    // para a mesma transação original.
    const reversed = await tx.findOne(WagerTransactionEntity, {
      referenceTransaction: original,
      type: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });

    if (reversed) {
      throw new ReferenceAlreadyReversedError();
    }

    return original;
  }

  private replay(existing: WagerTransactionEntity, input: WagerInput): ProcessBetOutput {
    const referenceExternalTransactionId =
      input.type === 'REFUND' || input.type === 'ROLLBACK'
        ? input.referenceExternalTransactionId
        : null;

    const samePayload =
      existing.wallet.id === input.walletId &&
      existing.providerId === input.providerId &&
      existing.externalTransactionId === input.externalTransactionId &&
      existing.type === input.type &&
      existing.amount === input.amount &&
      existing.currency === input.currency &&
      existing.referenceExternalTransactionId === referenceExternalTransactionId;

    if (!samePayload) {
      throw new IdempotencyConflictError();
    }

    return this.toOutput(existing);
  }

  private toOutput(wager: WagerTransactionEntity): ProcessBetOutput {
    return {
      transactionId: wager.id,
      walletId: wager.wallet.id,
      status: wager.status,
      balanceAfter: wager.balanceAfter,
      reason: wager.reason,
    };
  }
}
