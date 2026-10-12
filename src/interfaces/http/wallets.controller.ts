import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  Post,
} from '@nestjs/common';

import {
  CREATE_WALLET_USE_CASE,
  CreateWalletUseCase,
} from '../../application/wallets/create-wallet.use-case';

import { WalletAlreadyExistsError } from '../../application/wallets/wallet-already-exists.error';
import { CreateWalletDto } from './dto/create-wallet.dto';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET_USE_CASE)
    private readonly createWallet: CreateWalletUseCase,
  ) {}

  @Post()
  async create(@Body() dto: CreateWalletDto) {
    try {
      return await this.createWallet.execute(dto);
    } catch (error: unknown) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }

      if (error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }
}
