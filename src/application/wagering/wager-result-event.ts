import type { WagerOperation } from '../../domain/wagering-transaction/wager-operation';
import type { TransactionRejectionReason } from '../../domain/wagering-transaction/transaction-status';

export interface WagerResultEvent {
  schemaVersion: 1;
  kind: 'WAGER_TRANSACTION_FINALIZED';

  eventId: string;
  transactionId: string;
  walletId: string;

  providerId: string;
  externalTransactionId: string;

  type: WagerOperation;
  status: 'PROCESSED' | 'REJECTED';

  amount: string;
  currency: string;
  balanceAfter: string;

  reason: TransactionRejectionReason | null;
  referenceExternalTransactionId: string | null;

  occurredAt: string;
}
