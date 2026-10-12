import { Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import type { WalletPersistence } from '../../application/wallets/wallet-persistence';
import { WalletAlreadyExistsError } from '../../application/wallets/wallet-already-exists.error';

import type { Wallet } from '../../domain/wallet/wallet';
import type { LedgerEntry } from '../../domain/ledger/ledger-entry';

import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';

@Injectable()
export class PostgresWalletRepository implements WalletPersistence {
  constructor(private readonly em: EntityManager) {}

  async saveNew(wallet: Wallet, openingEntry: LedgerEntry | null): Promise<void> {
    try {
      await this.em.transactional(async (tx) => {
        const walletEntity = new WalletEntity();

        walletEntity.id = wallet.id;
        walletEntity.playerId = wallet.playerId;
        walletEntity.currency = wallet.currency;
        walletEntity.balance = wallet.balance.toString();

        tx.persist(walletEntity);

        if (openingEntry) {
          const ledgerEntity = new WalletLedgerEntryEntity();

          ledgerEntity.id = openingEntry.id;
          ledgerEntity.wallet = walletEntity;
          ledgerEntity.transactionId = openingEntry.transactionId;
          ledgerEntity.operation = openingEntry.operation;
          ledgerEntity.direction = openingEntry.direction;
          ledgerEntity.amount = openingEntry.amount.toString();
          ledgerEntity.balanceBefore = openingEntry.balanceBefore.toString();
          ledgerEntity.balanceAfter = openingEntry.balanceAfter.toString();
          ledgerEntity.occurredAt = new Date(openingEntry.occurredAt);

          tx.persist(ledgerEntity);
        }
      });
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }
}
