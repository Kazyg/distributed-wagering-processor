import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './infrastructure/database/mikro-orm.config';

import { HealthController } from './interfaces/http/health.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

import { WageringController } from './interfaces/http/wagering.controller';
import {
  PROCESS_REVERSAL_USE_CASE,
  ProcessReversalUseCase,
} from './application/wagering/process-reversal.use-case';

import {
  PROCESS_OUTCOME_USE_CASE,
  ProcessOutcomeUseCase,
} from './application/wagering/process-outcome.use-case';

import {
  PROCESS_BET_USE_CASE,
  ProcessBetUseCase,
} from './application/wagering/process-bet.use-case';

import { WalletReconciliationController } from './interfaces/http/wallet-reconciliation.controller';

import {
  RECONCILE_WALLET_USE_CASE,
  ReconcileWalletUseCase,
} from './application/reconciliation/reconcile-wallet.use-case';

import { PostgresReconciliationRepository } from './infrastructure/persistence/postgres-reconciliation.repository';

import { PostgresBetRepository } from './infrastructure/persistence/postgres-bet.repository';

import {
  CREATE_WALLET_USE_CASE,
  CreateWalletUseCase,
} from './application/wallets/create-wallet.use-case';

import { PostgresWalletRepository } from './infrastructure/persistence/postgres-wallet.repository';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [
    HealthController,
    WalletsController,
    WageringController,
    WalletReconciliationController,
  ],
  providers: [
    PostgresReconciliationRepository,
    {
      provide: RECONCILE_WALLET_USE_CASE,
      useFactory: (repository: PostgresReconciliationRepository) =>
        new ReconcileWalletUseCase(repository),
      inject: [PostgresReconciliationRepository],
    },
    PostgresWalletRepository,
    {
      provide: CREATE_WALLET_USE_CASE,
      useFactory: (repository: PostgresWalletRepository) => new CreateWalletUseCase(repository),
      inject: [PostgresWalletRepository],
    },
    PostgresBetRepository,
    {
      provide: PROCESS_BET_USE_CASE,
      useFactory: (repository: PostgresBetRepository) => new ProcessBetUseCase(repository),
      inject: [PostgresBetRepository],
    },
    {
      provide: PROCESS_OUTCOME_USE_CASE,
      useFactory: (repository: PostgresBetRepository) => new ProcessOutcomeUseCase(repository),
      inject: [PostgresBetRepository],
    },
    {
      provide: PROCESS_REVERSAL_USE_CASE,
      useFactory: (repository: PostgresBetRepository) => new ProcessReversalUseCase(repository),
      inject: [PostgresBetRepository],
    },
  ],
})
export class AppModule {}
