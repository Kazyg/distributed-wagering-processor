import { randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import type { WalletPersistence } from './wallet-persistence';

export const CREATE_WALLET_USE_CASE = Symbol('CREATE_WALLET_USE_CASE');

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  openingBalance?: string;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
}

export class CreateWalletUseCase {
  constructor(private readonly persistence: WalletPersistence) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const openingBalance = Money.from(input.openingBalance ?? '0.00', input.currency);

    const { wallet, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      currency: input.currency,
      openingBalance,
      openingEntryId: randomUUID(),
    });

    await this.persistence.saveNew(wallet, openingEntry);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
    };
  }
}
