import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { FeishuClient } from '../feishu/feishu.client';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

describe('AuthService', () => {
  it('requests writable Bitable access and offline refresh permission', () => {
    const config = new ConfigService({
      TOKEN_ENCRYPTION_KEY:
        'a-secure-test-encryption-key-that-is-longer-than-32-characters',
      FEISHU_LOGIN_ENABLED: true,
      FEISHU_APP_ID: 'cli_test',
      FEISHU_REDIRECT_URI: 'http://localhost:3001/api/auth/feishu/callback'
    });
    const feishu = {
      isConfigured: () => true
    } as FeishuClient;
    const service = new AuthService(
      config,
      {} as DatabaseService,
      feishu,
      new PasswordService()
    );

    const url = new URL(service.authorizationUrl('state-1'));

    expect(url.searchParams.get('scope')).toBe(
      'bitable:app offline_access'
    );
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('disables Feishu OAuth independently from Bitable integration', () => {
    const config = new ConfigService({
      TOKEN_ENCRYPTION_KEY:
        'a-secure-test-encryption-key-that-is-longer-than-32-characters',
      FEISHU_LOGIN_ENABLED: false
    });
    const feishu = {
      isConfigured: () => true
    } as FeishuClient;
    const service = new AuthService(
      config,
      {} as DatabaseService,
      feishu,
      new PasswordService()
    );

    expect(service.isConfigured()).toBe(true);
    expect(service.isFeishuLoginEnabled()).toBe(false);
    expect(() => service.authorizationUrl('state-1')).toThrow(
      '飞书授权登录已停用'
    );
  });

  it('logs a makeup artist into the makeup workspace with a local password', async () => {
    const passwords = new PasswordService();
    const passwordHash = await passwords.hash('artist-password-123');
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            user_id: 'user-1',
            person_id: 'person-1',
            display_name: '瞿敏',
            password_hash: passwordHash,
            login_allowed: true,
            employment_status: 'ACTIVE',
            disabled_at: null,
            locked_until: null,
            failed_login_count: 0,
            session_version: 1,
            roles: ['MAKEUP_ARTIST']
          }
        ]
      })
      .mockResolvedValue({ rows: [] });
    const db = {
      transaction: (callback: (client: { query: typeof query }) => unknown) =>
        callback({ query })
    } as unknown as DatabaseService;
    const service = new AuthService(
      new ConfigService({
        TOKEN_ENCRYPTION_KEY:
          'a-secure-test-encryption-key-that-is-longer-than-32-characters',
        FEISHU_LOGIN_ENABLED: false
      }),
      db,
      { isConfigured: () => true } as FeishuClient,
      passwords
    );

    await expect(
      service.loginWithPassword('artist01', 'artist-password-123')
    ).resolves.toMatchObject({
      userId: 'user-1',
      displayName: '瞿敏',
      landingPath: '/makeup/tasks',
      sessionVersion: 1
    });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
