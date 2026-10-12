import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';

import {
  PROCESS_REVERSAL_USE_CASE,
  ProcessReversalUseCase,
  InvalidReversalError,
  ReferenceNotFoundError,
  ReferenceAlreadyReversedError,
} from '../../application/wagering/process-reversal.use-case';

import {
  IdempotencyConflictError,
  InvalidBetError,
  PROCESS_BET_USE_CASE,
  ProcessBetUseCase,
  WalletNotFoundError,
} from '../../application/wagering/process-bet.use-case';

import {
  PROCESS_OUTCOME_USE_CASE,
  ProcessOutcomeUseCase,
} from '../../application/wagering/process-outcome.use-case';

import { ProcessBetDto } from './dto/process-bet.dto';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(PROCESS_BET_USE_CASE)
    private readonly processBet: ProcessBetUseCase,

    @Inject(PROCESS_REVERSAL_USE_CASE)
    private readonly processReversal: ProcessReversalUseCase,

    @Inject(PROCESS_OUTCOME_USE_CASE)
    private readonly processOutcome: ProcessOutcomeUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() dto: ProcessBetDto) {
    try {
      const { type = 'BET', referenceExternalTransactionId, ...input } = dto;

      if (type === 'REFUND' || type === 'ROLLBACK') {
        return await this.processReversal.execute({
          ...input,
          type,
          referenceExternalTransactionId: referenceExternalTransactionId ?? '',
        });
      }

      if (referenceExternalTransactionId !== undefined) {
        throw new BadRequestException('Only reversals can reference another transaction');
      }

      if (type === 'BET') {
        return await this.processBet.execute(input);
      }

      return await this.processOutcome.execute({
        ...input,
        type,
      });
    } catch (error: unknown) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }

      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }

      if (error instanceof InvalidBetError) {
        throw new BadRequestException(error.message);
      }

      if (error instanceof InvalidReversalError) {
        throw new BadRequestException(error.message);
      }

      if (error instanceof ReferenceNotFoundError) {
        throw new ConflictException(error.message);
      }

      if (error instanceof ReferenceAlreadyReversedError) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}
