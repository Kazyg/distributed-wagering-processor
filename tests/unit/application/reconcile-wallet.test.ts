import { describe, expect, test } from 'bun:test';

import {
  ReconcileWalletUseCase,
  type WalletReconciliationReader,
  type WalletReconciliationReport,
} from '../../../src/application/reconciliation/reconcile-wallet.use-case';

const validReport: WalletReconciliationReport = {
  walletId: 'wallet-1',
  currency: 'BRL',
  storedBalance: '70.00',
  ledgerBalance: '70.00',
  difference: '0.00',
  entryCount: 2,
  consistent: true,
};

describe('ReconcileWalletUseCase', () => {
  test('should return the reconciliation report', async () => {
    const reader: WalletReconciliationReader = {
      async getReport() {
        return validReport;
      },
    };

    const useCase = new ReconcileWalletUseCase(reader);

    const result = await useCase.execute('wallet-1');

    expect(result).toEqual(validReport);
    expect(result?.consistent).toBe(true);
  });

  test('should return null for a missing wallet', async () => {
    const reader: WalletReconciliationReader = {
      async getReport() {
        return null;
      },
    };

    const useCase = new ReconcileWalletUseCase(reader);

    const result = await useCase.execute('missing-wallet');

    expect(result).toBeNull();
  });
});
