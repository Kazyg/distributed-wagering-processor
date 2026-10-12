import { describe, expect, test } from 'bun:test';

import { CreateWalletUseCase } from '../../../src/application/wallets/create-wallet.use-case';
import type { WalletPersistence } from '../../../src/application/wallets/wallet-persistence';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import type { LedgerEntry } from '../../../src/domain/ledger/ledger-entry';

function createFakePersistence() {
  const saved: Array<{
    wallet: Wallet;
    openingEntry: LedgerEntry | null;
  }> = [];

  const persistence: WalletPersistence = {
    async saveNew(wallet, openingEntry) {
      saved.push({ wallet, openingEntry });
    },
  };

  return { persistence, saved };
}

describe('CreateWalletUseCase', () => {
  test('should create a wallet with an opening ledger entry', async () => {
    const { persistence, saved } = createFakePersistence();
    const useCase = new CreateWalletUseCase(persistence);

    const result = await useCase.execute({
      playerId: 'player-1',
      currency: 'BRL',
      openingBalance: '100.00',
    });

    expect(result.balance).toBe('100.00');
    expect(result.currency).toBe('BRL');

    expect(saved).toHaveLength(1);
    expect(saved[0]?.openingEntry?.operation).toBe('OPENING');
    expect(saved[0]?.openingEntry?.amount.toString()).toBe('100.00');
  });

  test('should create a zero-balance wallet without ledger entry', async () => {
    const { persistence, saved } = createFakePersistence();
    const useCase = new CreateWalletUseCase(persistence);

    const result = await useCase.execute({
      playerId: 'player-2',
      currency: 'BRL',
    });

    expect(result.balance).toBe('0.00');
    expect(saved[0]?.openingEntry).toBeNull();
  });

  test('should propagate persistence failures', async () => {
    const persistence: WalletPersistence = {
      async saveNew() {
        throw new Error('Database unavailable');
      },
    };

    const useCase = new CreateWalletUseCase(persistence);

    await expect(
      useCase.execute({
        playerId: 'player-3',
        currency: 'BRL',
        openingBalance: '50.00',
      }),
    ).rejects.toThrow('Database unavailable');
  });
});
