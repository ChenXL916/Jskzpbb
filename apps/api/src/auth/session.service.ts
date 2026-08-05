import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

interface SessionPayload {
  userId: string;
  sessionVersion: number;
  expiresAt: number;
}

@Injectable()
export class SessionService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('SESSION_SECRET');
  }

  sign(
    userId: string,
    sessionVersion: number,
    ttlSeconds = 8 * 60 * 60
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        userId,
        sessionVersion,
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds
      } satisfies SessionPayload)
    ).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  verify(token: string): SessionPayload {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) {
      throw new UnauthorizedException('登录状态无效');
    }
    const expected = this.signature(payload);
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('登录状态无效');
    }
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('登录状态已过期');
    }
    return parsed;
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
