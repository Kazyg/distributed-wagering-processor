import { IsNotEmpty, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  playerId!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(19)
  @Matches(/^(0|[1-9]\d{0,15})\.\d{2}$/)
  openingBalance?: string;
}
