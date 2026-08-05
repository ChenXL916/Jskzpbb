import {
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { OAuthTokenResponse } from './feishu.client';

interface UserTokenRow {
  id: string;
  access_token_encrypted: Buffer | null;
  refresh_token_encrypted: Buffer | null;
  token_expires_at: Date | string | null;
  refresh_expires_at: Date | string | null;
}

interface OAuthEnvelope {
  code?: number;
  msg?: string;
  data?: OAuthTokenResponse;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

const REFRESH_BUFFER_MS = 5 * 60_000;

@Injectable()
export class FeishuUserTokenService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService
  ) {
    this.encryptionKey = createHash('sha256')
      .update(config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY'))
      .digest();
  }

  async validAccessToken(forceRefresh = false): Promise<string | null> {
    const row = await this.findAuthorizedUser();
    if (!row) return null;

    if (
      !forceRefresh &&
      row.access_token_encrypted &&
      this.isAfterBuffer(row.token_expires_at)
    ) {
      return this.decrypt(row.access_token_encrypted);
    }

    return this.refreshLocked(row.id, forceRefresh);
  }

  private async findAuthorizedUser(): Promise<UserTokenRow | null> {
    const result = await this.db.query<UserTokenRow>(
      `
        SELECT u.id, u.access_token_encrypted, u.refresh_token_encrypted,
               u.token_expires_at, u.refresh_expires_at
        FROM users u
        JOIN people p ON p.id = u.person_id
        WHERE p.login_allowed
          AND p.archived_at IS NULL
          AND u.disabled_at IS NULL
          AND u.access_token_encrypted IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM person_roles pr
            WHERE pr.person_id = p.id
              AND pr.enabled
              AND pr.role IN ('ADMIN', 'DEVELOPER')
          )
        ORDER BY u.last_login_at DESC NULLS LAST, u.updated_at DESC
        LIMIT 1
      `
    );
    return result.rows[0] ?? null;
  }

  private refreshLocked(userId: string, forceRefresh: boolean): Promise<string> {
    return this.db.transaction(async (client) => {
      const current = await this.lockUser(client, userId);
      if (
        !forceRefresh &&
        current.access_token_encrypted &&
        this.isAfterBuffer(current.token_expires_at)
      ) {
        return this.decrypt(current.access_token_encrypted);
      }
      if (!current.refresh_token_encrypted) {
        throw new ServiceUnavailableException(
          '飞书用户授权已过期，请重新登录并授权多维表格权限'
        );
      }
      if (
        current.refresh_expires_at &&
        !this.isFuture(current.refresh_expires_at)
      ) {
        throw new ServiceUnavailableException(
          '飞书长期授权已过期，请重新登录并授权多维表格权限'
        );
      }

      const refreshed = await this.refreshTokens(
        this.decrypt(current.refresh_token_encrypted)
      );
      if (!refreshed.refresh_token) {
        throw new ServiceUnavailableException(
          '飞书未返回新的 refresh_token，请重新授权 offline_access'
        );
      }
      await client.query(
        `
          UPDATE users
          SET access_token_encrypted=$2,
              refresh_token_encrypted=$3,
              token_expires_at=now() + ($4 || ' seconds')::interval,
              refresh_expires_at=CASE WHEN $5::int IS NULL THEN NULL
                ELSE now() + ($5 || ' seconds')::interval END,
              updated_at=now()
          WHERE id=$1
        `,
        [
          userId,
          this.encrypt(refreshed.access_token),
          this.encrypt(refreshed.refresh_token),
          refreshed.expires_in,
          refreshed.refresh_token_expires_in ?? null
        ]
      );
      return refreshed.access_token;
    });
  }

  private async lockUser(
    client: PoolClient,
    userId: string
  ): Promise<UserTokenRow> {
    const result = await client.query<UserTokenRow>(
      `
        SELECT id, access_token_encrypted, refresh_token_encrypted,
               token_expires_at, refresh_expires_at
        FROM users
        WHERE id=$1
        FOR UPDATE
      `,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ServiceUnavailableException('飞书授权用户不存在，请重新登录');
    }
    return row;
  }

  private async refreshTokens(refreshToken: string): Promise<OAuthTokenResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(
          'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              client_id: this.config.getOrThrow<string>('FEISHU_APP_ID'),
              client_secret: this.config.getOrThrow<string>('FEISHU_APP_SECRET'),
              refresh_token: refreshToken
            }),
            signal: AbortSignal.timeout(10_000)
          }
        );
        const payload = (await response.json()) as OAuthEnvelope;
        const data = payload.data ?? payload;
        const code = Number(payload.code ?? 0);
        if (
          response.ok &&
          code === 0 &&
          typeof data.access_token === 'string' &&
          typeof data.expires_in === 'number'
        ) {
          return {
            access_token: data.access_token,
            expires_in: data.expires_in,
            ...(typeof data.refresh_token === 'string'
              ? { refresh_token: data.refresh_token }
              : {}),
            ...(typeof data.refresh_token_expires_in === 'number'
              ? {
                  refresh_token_expires_in:
                    data.refresh_token_expires_in
                }
              : {}),
            ...(typeof data.scope === 'string' ? { scope: data.scope } : {})
          };
        }
        if (
          attempt < 2 &&
          (response.status === 429 || response.status >= 500)
        ) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ServiceUnavailableException(
          `飞书用户令牌刷新失败（code=${code || response.status}），请重新授权`
        );
      } catch (error) {
        lastError = error;
        if (
          attempt < 2 &&
          !(error instanceof ServiceUnavailableException)
        ) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
    throw new ServiceUnavailableException(
      lastError instanceof Error ? lastError.message : '飞书用户令牌刷新失败'
    );
  }

  private isAfterBuffer(value: Date | string | null): boolean {
    return this.toTimestamp(value) > Date.now() + REFRESH_BUFFER_MS;
  }

  private isFuture(value: Date | string | null): boolean {
    return this.toTimestamp(value) > Date.now();
  }

  private toTimestamp(value: Date | string | null): number {
    if (!value) return 0;
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private encrypt(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  private decrypt(value: Buffer): string {
    if (value.length < 29) {
      throw new ServiceUnavailableException(
        '飞书授权凭据损坏，请重新登录授权'
      );
    }
    const iv = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const encrypted = value.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException(
        '飞书授权凭据无法解密，请重新登录授权'
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
