import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PersonRole } from '@jishi/contracts';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { FeishuClient, FeishuUserInfo, OAuthTokenResponse } from '../feishu/feishu.client';
import { PasswordService } from './password.service';

interface LocalLoginRow {
  user_id: string;
  person_id: string;
  display_name: string;
  password_hash: string;
  login_allowed: boolean;
  employment_status: string;
  disabled_at: Date | null;
  locked_until: Date | null;
  failed_login_count: number;
  session_version: number;
  roles: PersonRole[];
}

export interface LocalLoginResult {
  userId: string;
  displayName: string;
  roles: PersonRole[];
  landingPath: string;
  sessionVersion: number;
}

@Injectable()
export class AuthService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly feishu: FeishuClient,
    private readonly passwords: PasswordService
  ) {
    this.encryptionKey = createHash('sha256')
      .update(config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY'))
      .digest();
  }

  isConfigured(): boolean {
    return this.feishu.isConfigured();
  }

  isFeishuLoginEnabled(): boolean {
    return this.config.get<boolean>('FEISHU_LOGIN_ENABLED') ?? false;
  }

  authorizationUrl(state: string): string {
    if (!this.isFeishuLoginEnabled()) {
      throw new ForbiddenException('飞书授权登录已停用，请使用系统账号登录');
    }
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('飞书 App ID 或 App Secret 尚未配置');
    }
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.searchParams.set('client_id', this.config.getOrThrow<string>('FEISHU_APP_ID'));
    url.searchParams.set(
      'redirect_uri',
      this.config.getOrThrow<string>('FEISHU_REDIRECT_URI')
    );
    url.searchParams.set('scope', 'bitable:app offline_access');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeAndBind(
    code: string
  ): Promise<{
    userId: string;
    pending: boolean;
    landingPath: string;
    sessionVersion: number;
  }> {
    if (!this.isFeishuLoginEnabled()) {
      throw new ForbiddenException('飞书授权登录已停用，请使用系统账号登录');
    }
    const token = await this.feishu.exchangeAuthorizationCode(code);
    const profile = await this.feishu.getUserInfo(token.access_token);
    return this.db.transaction((client) => this.upsertUser(client, profile, token));
  }

  async loginWithPassword(
    username: string,
    password: string,
    ipAddress?: string
  ): Promise<LocalLoginResult> {
    const normalizedUsername = username.trim().toLowerCase();
    return this.db.transaction(async (client) => {
      const result = await client.query<LocalLoginRow>(
        `
          SELECT u.id AS user_id, p.id AS person_id, p.display_name,
                 u.password_hash, p.login_allowed, p.employment_status,
                 u.disabled_at, u.locked_until, u.failed_login_count,
                 u.session_version,
                 ARRAY(
                   SELECT DISTINCT available.role_code
                   FROM (
                     SELECT role.code AS role_code
                     FROM user_role_bindings binding
                     JOIN roles role ON role.id=binding.role_id
                     WHERE binding.user_id=u.id AND binding.enabled AND role.enabled
                     UNION
                     SELECT legacy.role::text AS role_code
                     FROM person_roles legacy
                     WHERE legacy.person_id=p.id AND legacy.enabled
                   ) available
                 ) AS roles
          FROM users u
          JOIN people p ON p.id=u.person_id
          WHERE lower(u.username)=$1
            AND u.password_hash IS NOT NULL
          FOR UPDATE OF u
        `,
        [normalizedUsername]
      );
      const account = result.rows[0];
      if (!account) {
        await this.passwords.performDummyCheck(password);
        throw new UnauthorizedException('账号或密码错误');
      }

      const passwordMatches = await this.passwords.verify(
        password,
        account.password_hash
      );
      if (!passwordMatches) {
        await client.query(
          `
            UPDATE users
            SET failed_login_count=failed_login_count + 1,
                last_failed_login_at=now(),
                locked_until=CASE
                  WHEN failed_login_count + 1 >= 5
                    THEN now() + interval '15 minutes'
                  ELSE locked_until
                END,
                updated_at=now()
            WHERE id=$1
          `,
          [account.user_id]
        );
        throw new UnauthorizedException('账号或密码错误');
      }

      if (account.locked_until && account.locked_until.getTime() > Date.now()) {
        throw new UnauthorizedException('登录尝试过多，请15分钟后重试');
      }
      if (
        account.disabled_at ||
        !account.login_allowed ||
        account.employment_status !== 'ACTIVE'
      ) {
        throw new ForbiddenException('账号已停用，请联系管理员');
      }
      if (!account.roles.length) {
        throw new ForbiddenException('账号尚未配置岗位角色');
      }

      await client.query(
        `
          UPDATE users
          SET failed_login_count=0, last_failed_login_at=NULL,
              locked_until=NULL, last_login_at=now(), updated_at=now()
          WHERE id=$1
        `,
        [account.user_id]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, ip_address, after_data
          ) VALUES ($1,'LOGIN','USER',$2,$3,$4)
        `,
        [
          account.person_id,
          account.user_id,
          ipAddress ?? null,
          JSON.stringify({ authSource: 'LOCAL' })
        ]
      );
      return {
        userId: account.user_id,
        displayName: account.display_name,
        roles: account.roles,
        landingPath: this.landingPath(account.roles),
        sessionVersion: account.session_version
      };
    });
  }

  private async upsertUser(
    client: PoolClient,
    profile: FeishuUserInfo,
    token: OAuthTokenResponse
  ): Promise<{
    userId: string;
    pending: boolean;
    landingPath: string;
    sessionVersion: number;
  }> {
    const existing = await client.query<{
      user_id: string;
      person_id: string;
      login_allowed: boolean;
    }>(
      `
        SELECT u.id AS user_id, p.id AS person_id, p.login_allowed
        FROM users u
        JOIN people p ON p.id = u.person_id
        WHERE u.feishu_open_id = $1
      `,
      [profile.open_id]
    );

    let userId: string;
    let personId: string;
    let loginAllowed: boolean;
    const bootstrapOpenId = this.config.get<string>('FEISHU_BOOTSTRAP_ADMIN_OPEN_ID') ?? '';

    if (existing.rows[0]) {
      ({ user_id: userId, person_id: personId, login_allowed: loginAllowed } =
        existing.rows[0]);
      await client.query(
        `
          UPDATE people
          SET display_name = $2, avatar_url = $3, feishu_user_id = COALESCE($4, feishu_user_id),
              feishu_union_id = COALESCE($5, feishu_union_id), updated_at = now()
          WHERE id = $1
        `,
        [
          personId,
          profile.name,
          profile.avatar_url ?? null,
          profile.user_id ?? null,
          profile.union_id ?? null
        ]
      );
    } else {
      personId = randomUUID();
      userId = randomUUID();
      loginAllowed = bootstrapOpenId !== '' && bootstrapOpenId === profile.open_id;
      await client.query(
        `
          INSERT INTO people(
            id, display_name, feishu_user_id, feishu_open_id, feishu_union_id,
            avatar_url, email, phone, employee_no, login_allowed
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          personId,
          profile.name,
          profile.user_id ?? null,
          profile.open_id,
          profile.union_id ?? null,
          profile.avatar_url ?? null,
          profile.enterprise_email ?? profile.email ?? null,
          profile.mobile ?? null,
          profile.employee_no ?? null,
          loginAllowed
        ]
      );
      await client.query(
        'INSERT INTO users(id, person_id, feishu_open_id, feishu_union_id) VALUES ($1,$2,$3,$4)',
        [userId, personId, profile.open_id, profile.union_id ?? null]
      );
      if (loginAllowed) {
        await client.query(
          `
            INSERT INTO person_roles(person_id, role) VALUES
              ($1, 'ADMIN'), ($1, 'DEVELOPER')
            ON CONFLICT DO NOTHING
          `,
          [personId]
        );
      }
    }

    await client.query(
      `
        UPDATE users
        SET access_token_encrypted = $2, refresh_token_encrypted = $3,
            token_expires_at = now() + ($4 || ' seconds')::interval,
            refresh_expires_at = CASE WHEN $5::int IS NULL THEN NULL
              ELSE now() + ($5 || ' seconds')::interval END,
            last_login_at = now(), updated_at = now()
        WHERE id = $1
      `,
      [
        userId,
        this.encrypt(token.access_token),
        token.refresh_token ? this.encrypt(token.refresh_token) : null,
        token.expires_in,
        token.refresh_token_expires_in ?? null
      ]
    );

    const roles = await client.query<{ role: string }>(
      `
        SELECT role::text AS role
        FROM person_roles
        WHERE person_id=$1 AND enabled
      `,
      [personId]
    );
    const roleCodes = roles.rows.map((row) => row.role);
    const landingPath = this.landingPath(roleCodes as PersonRole[]);

    const session = await client.query<{ session_version: number }>(
      'SELECT session_version FROM users WHERE id=$1',
      [userId]
    );

    return {
      userId,
      pending: !loginAllowed,
      landingPath,
      sessionVersion: session.rows[0]?.session_version ?? 1
    };
  }

  async revokeSessions(userId: string): Promise<void> {
    await this.db.query(
      `
        UPDATE users
        SET session_version=session_version+1, updated_at=now()
        WHERE id=$1
      `,
      [userId]
    );
  }

  private landingPath(roles: PersonRole[]): string {
    return roles.some((role) => ['ADMIN', 'DEVELOPER'].includes(role))
      ? '/admin'
      : roles.includes('LIVE_SUPERVISOR')
        ? '/management'
        : roles.includes('FIELD_CONTROL')
          ? '/control'
          : roles.includes('MAKEUP_ARTIST')
            ? '/makeup/tasks'
            : roles.some((role) => ['TALENT', 'DIRECTOR'].includes(role))
              ? '/requester'
              : '/today';
  }

  private encrypt(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
}
