import { createHash, timingSafeEqual } from 'node:crypto';

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expectedDigest: Buffer;

  constructor() {
    const apiKey = process.env.API_KEY;

    if (!apiKey || apiKey.length < 32) {
      throw new Error('API_KEY must be configured with at least 32 characters');
    }

    this.expectedDigest = createHash('sha256').update(apiKey).digest();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const providedKey = request.headers['x-api-key'];

    if (typeof providedKey !== 'string') {
      throw new UnauthorizedException('Invalid API key');
    }

    const providedDigest = createHash('sha256').update(providedKey).digest();

    if (!timingSafeEqual(providedDigest, this.expectedDigest)) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
