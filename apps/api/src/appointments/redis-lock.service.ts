import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

@Injectable()
export class RedisLockService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
    this.redis.on('error', () => undefined);
  }

  async acquire(
    key: string,
    ttlMs = 10_000
  ): Promise<{ release: () => Promise<void> } | null> {
    const token = randomUUID();
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (result !== 'OK') return null;
      return {
        release: async () => {
          await this.redis
            .eval(
              `if redis.call("get", KEYS[1]) == ARGV[1] then
                 return redis.call("del", KEYS[1])
               else return 0 end`,
              1,
              key,
              token
            )
            .catch(() => undefined);
        }
      };
    } catch {
      this.logger.warn('Redis 暂不可用，继续使用 PostgreSQL 事务锁和排斥约束');
      return { release: async () => undefined };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}
