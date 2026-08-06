import { config } from 'dotenv';
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

config({ path: join(process.cwd(), '../../.env') });

interface JsonObject {
  [key: string]: unknown;
}

function signSession(userId: string, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      expiresAt: Math.floor(Date.now() / 1000) + 10 * 60
    })
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

async function request(
  path: string,
  cookie: string,
  init?: RequestInit
): Promise<{ status: number; data: JsonObject }> {
  const response = await fetch(`http://localhost:3002/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie: `jishi_session=${cookie}`,
      ...(init?.headers ?? {})
    }
  });
  const data = (await response.json()) as JsonObject;
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(data)}`);
  }
  return { status: response.status, data };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!databaseUrl || !sessionSecret) {
    throw new Error('DATABASE_URL or SESSION_SECRET is missing');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const account = await pool.query<{ user_id: string }>(
      `SELECT account.id AS user_id
       FROM users account
       JOIN user_role_bindings binding
         ON binding.user_id=account.id AND binding.enabled
       JOIN roles role ON role.id=binding.role_id AND role.enabled
       WHERE role.code='DEVELOPER' AND account.disabled_at IS NULL
       ORDER BY account.created_at
       LIMIT 1`
    );
    const userId = account.rows[0]?.user_id;
    if (!userId) throw new Error('No enabled developer account');
    const cookie = signSession(userId, sessionSecret);
    if (process.env.SMOKE_COOKIE_OUTPUT) {
      await writeFile(
        process.env.SMOKE_COOKIE_OUTPUT,
        `Cookie: jishi_session=${cookie}\n`,
        {
        encoding: 'utf8',
        mode: 0o600
        }
      );
    }
    if (process.env.SMOKE_STATE_OUTPUT) {
      await writeFile(
        process.env.SMOKE_STATE_OUTPUT,
        JSON.stringify({
          cookies: [
            {
              name: 'jishi_session',
              value: cookie,
              domain: 'localhost',
              path: '/',
              expires: Math.floor(Date.now() / 1000) + 10 * 60,
              httpOnly: true,
              secure: false,
              sameSite: 'Lax'
            }
          ],
          origins: []
        }),
        { encoding: 'utf8', mode: 0o600 }
      );
    }
    const me = await request('/auth/me', cookie);
    const options = await request('/schedule-plans/options', cookie);
    const optionRooms = options.data.rooms as Array<{ id: string }>;
    const dataSources = options.data.dataSources as Array<{
      code: string;
      is_primary: boolean;
      enabled: boolean;
    }>;
    const primarySource = dataSources.find((source) => source.is_primary);
    if (!optionRooms.length) throw new Error('No enabled room returned by options');
    const configuration = await request(
      '/admin/scheduling/configuration',
      cookie
    );
    const precheck = await request('/schedule-plans/precheck', cookie, {
      method: 'POST',
      body: JSON.stringify({
        month: '2026-09',
        roomIds: optionRooms.map((room) => room.id),
        blockHours: 3,
        coverageStartHour: 0,
        coverageEndHour: 24,
        strategy: 'BALANCED',
        existingSchedulePolicy: 'PRESERVE_EXISTING'
      })
    });
    const web = await fetch('http://localhost:8088/schedule/plans');
    process.stdout.write(
      `${JSON.stringify(
        {
          authenticatedMe: me.status,
          roleCount: Array.isArray(me.data.roles) ? me.data.roles.length : 0,
          optionsStatus: options.status,
          dataAuthority: primarySource?.code ?? null,
          feishuSourceEnabled:
            dataSources.find((source) => source.code === 'FEISHU_ARCHIVE')
              ?.enabled ?? null,
          roomCount: optionRooms.length,
          configurationStatus: configuration.status,
          profileCount: Array.isArray(configuration.data.profiles)
            ? configuration.data.profiles.length
            : 0,
          precheckStatus: precheck.status,
          precheckFeasible: precheck.data.feasible,
          precheckBlockerCount: Array.isArray(precheck.data.blockers)
            ? precheck.data.blockers.length
            : 0,
          webSchedulePlansStatus: web.status
        },
        null,
        2
      )}\n`
    );
  } finally {
    await pool.end();
  }
}

void main();
