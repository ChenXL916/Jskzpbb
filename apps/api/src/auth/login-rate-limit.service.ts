import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

@Injectable()
export class LoginRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(LoginRateLimitService.name);
  private readonly redis: Redis;
  private warnedUnavailable = false;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000
    });
    this.redis.on('error', () => undefined);
  }

  async assertAllowed(ipAddress: string | undefined, username: string) {
    const key = this.key(ipAddress, username);
    try {
      await this.ensureConnected();
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 5 * 60);
      if (count > 20) {
        throw new HttpException(
          '登录尝试过于频繁，请5分钟后重试',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (!this.warnedUnavailable) {
        this.logger.warn('Redis unavailable; login rate limit is temporarily degraded');
        this.warnedUnavailable = true;
      }
    }
  }

  async reset(ipAddress: string | undefined, username: string) {
    try {
      await this.ensureConnected();
      await this.redis.del(this.key(ipAddress, username));
    } catch {
      // Login succeeded. Redis unavailability must not invalidate the session.
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready' || this.redis.status === 'connecting') {
      await this.redis.quit().catch(() => undefined);
    }
  }

  private async ensureConnected() {
    if (this.redis.status === 'wait') await this.redis.connect();
  }

  private key(ipAddress: string | undefined, username: string) {
    const digest = createHash('sha256')
      .update(`${ipAddress ?? 'unknown'}:${username.trim().toLowerCase()}`)
      .digest('hex');
    return `auth:login-rate:${digest}`;
  }
}
