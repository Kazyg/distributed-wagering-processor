import { Controller, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  RECONCILE_WALLET_USE_CASE,
  ReconcileWalletUseCase,
} from '../../application/reconciliation/reconcile-wallet.use-case';

@Controller('wallets')
export class WalletReconciliationController {
  constructor(
    @Inject(RECONCILE_WALLET_USE_CASE)
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post(':walletId/reconciliation')
  async reconcile(
    @Param('walletId', new ParseUUIDPipe({ version: '4' }))
    walletId: string,
  ) {
    const report = await this.reconcileWallet.execute(walletId);

    if (!report) {
      throw new NotFoundException('Wallet not found');
    }

    return report;
  }
}
