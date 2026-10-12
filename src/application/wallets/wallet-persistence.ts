import type { Wallet } from '../../domain/wallet/wallet';
import type { LedgerEntry } from '../../domain/ledger/ledger-entry';

export interface WalletPersistence {
  saveNew(wallet: Wallet, openingEntry: LedgerEntry | null): Promise<void>;
}
