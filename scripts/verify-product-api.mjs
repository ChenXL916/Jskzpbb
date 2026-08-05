import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from '../apps/api/node_modules/pg/lib/index.js';

const envText = await readFile(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const splitAt = line.indexOf('=');
      return [line.slice(0, splitAt), line.slice(splitAt + 1)];
    })
);

if (!env.DATABASE_URL || !env.SESSION_SECRET) {
  throw new Error('DATABASE_URL 或 SESSION_SECRET 未配置');
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const userResult = await pool.query(`
  SELECT users.id, users.session_version
  FROM users
  JOIN people ON people.id=users.person_id
  JOIN person_roles ON person_roles.person_id=people.id
  WHERE people.login_allowed AND users.disabled_at IS NULL
    AND person_roles.enabled
    AND person_roles.role IN ('ADMIN','DEVELOPER')
  ORDER BY users.created_at
  LIMIT 1
`);
const userId = userResult.rows[0]?.id;
if (!userId) throw new Error('没有可用于只读验收的管理员账号');

const payload = Buffer.from(
  JSON.stringify({
    userId,
    sessionVersion: userResult.rows[0]?.session_version ?? 1,
    expiresAt: Math.floor(Date.now() / 1000) + 300
  })
).toString('base64url');
const signature = createHmac('sha256', env.SESSION_SECRET)
  .update(payload)
  .digest('base64url');
const cookie = `jishi_session=${payload}.${signature}`;
const baseUrl = process.env.API_URL ?? 'http://localhost:3002/api';
const paths = [
  '/auth/me',
  '/admin/roles',
  '/admin/permissions',
  '/admin/people',
  '/admin/rooms',
  '/admin/shift-templates',
  '/admin/booking-rules',
  '/admin/schedule-notifications/rules',
  '/admin/schedule-notifications/outbox?page=1&pageSize=5',
  '/admin/sync-jobs?page=1&pageSize=5',
  '/admin/operation-logs?page=1&pageSize=5',
  '/management/dashboard',
  '/management/workload',
  '/risks',
  '/notifications?page=1&pageSize=5',
  '/me/appointments',
  '/makeup-artists/availability'
];

const results = [];
for (const path of paths) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { cookie }
  });
  const body = await response.json().catch(() => null);
  results.push({
    path,
    status: response.status,
    resultType: Array.isArray(body) ? 'array' : typeof body,
    itemCount: Array.isArray(body)
      ? body.length
      : Array.isArray(body?.items)
        ? body.items.length
        : undefined
  });
}

await pool.end();
console.table(results);
if (results.some((result) => result.status !== 200)) {
  process.exitCode = 1;
}
