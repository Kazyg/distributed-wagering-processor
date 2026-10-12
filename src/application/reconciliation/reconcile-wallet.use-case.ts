export const RECONCILE_WALLET_USE_CASE = Symbol('RECONCILE_WALLET_USE_CASE');

export interface WalletReconciliationReport {
  walletId: string;
  currency: string;
  storedBalance: string;
  ledgerBalance: string;
  difference: string;
  entryCount: number;
  consistent: boolean;
}

export interface WalletReconciliationReader {
  getReport(walletId: string): Promise<WalletReconciliationReport | null>;
}

export class ReconcileWalletUseCase {
  constructor(private readonly reader: WalletReconciliationReader) {}

  execute(walletId: string): Promise<WalletReconciliationReport | null> {
    return this.reader.getReport(walletId);
  }
}
