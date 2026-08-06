import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createHash,
  randomBytes
} from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { FeishuUserTokenService } from './feishu-user-token.service';

const encryptionSecret =
  'a-secure-test-encryption-key-that-is-longer-than-32-characters';

function encryptFixture(value: string): Buffer {
  const key = createHash('sha256').update(encryptionSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

describe('FeishuUserTokenService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('decrypts and returns a still-valid admin user token', async () => {
    const transaction = jest.fn();
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'user-1',
            access_token_encrypted: encryptFixture('u-valid-token'),
            refresh_token_encrypted: encryptFixture('ur-valid-token'),
            token_expires_at: new Date(Date.now() + 60 * 60_000),
            refresh_expires_at: new Date(Date.now() + 24 * 60 * 60_000)
          }
        ]
      }),
      transaction
    } as unknown as DatabaseService;
    const service = new FeishuUserTokenService(
      new ConfigService({
        TOKEN_ENCRYPTION_KEY: encryptionSecret,
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret'
      }),
      db
    );

    await expect(service.validAccessToken()).resolves.toBe('u-valid-token');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and stores the rotated refresh token', async () => {
    const expired = {
      id: 'user-1',
      access_token_encrypted: encryptFixture('u-expired-token'),
      refresh_token_encrypted: encryptFixture('ur-old-token'),
      token_expires_at: new Date(Date.now() - 60_000),
      refresh_expires_at: new Date(Date.now() + 24 * 60 * 60_000)
    };
    const sqlCalls: string[] = [];
    let queryCount = 0;
    const clientQuery = jest.fn(
      async (sql: string): Promise<{ rows: unknown[] }> => {
        sqlCalls.push(sql);
        queryCount += 1;
        return queryCount === 1 ? { rows: [expired] } : { rows: [] };
      }
    );
    const client = { query: clientQuery };
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [expired] }),
      transaction: jest.fn(
        async (work: (value: typeof client) => Promise<string>) =>
          work(client)
      )
    } as unknown as DatabaseService;
    const service = new FeishuUserTokenService(
      new ConfigService({
        TOKEN_ENCRYPTION_KEY: encryptionSecret,
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret'
      }),
      db
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          access_token: 'u-new-token',
          refresh_token: 'ur-new-token',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: 'bitable:app offline_access'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(service.validAccessToken()).resolves.toBe('u-new-token');

    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof rawBody !== 'string') {
      throw new Error('Expected a JSON request body');
    }
    const requestBody = JSON.parse(rawBody) as Record<string, string>;
    expect(requestBody.refresh_token).toBe('ur-old-token');
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(sqlCalls[1]).toContain('UPDATE users');
  });
});
