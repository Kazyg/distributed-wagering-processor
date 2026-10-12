import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { IsIn, ValidateIf } from 'class-validator';

import type { WagerOperation } from '../../../domain/wagering-transaction/wager-operation';

export class ProcessBetDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  type?: WagerOperation;
  @IsUUID('4')
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  externalTransactionId!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @Matches(/^(?!0\.00$)(0|[1-9]\d{0,15})\.\d{2}$/)
  amount!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
