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
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const user = await pool.query(`
  SELECT users.id, users.session_version
  FROM users
  JOIN people ON people.id=users.person_id
  JOIN person_roles ON person_roles.person_id=people.id
  WHERE people.login_allowed AND users.disabled_at IS NULL
    AND person_roles.enabled AND person_roles.role='DEVELOPER'
  ORDER BY users.created_at
  LIMIT 1
`);
const userId = user.rows[0]?.id;
if (!userId || !env.SESSION_SECRET) throw new Error('缺少可用开发者账号或会话密钥');
const payload = Buffer.from(
  JSON.stringify({
    userId,
    sessionVersion: user.rows[0]?.session_version ?? 1,
    expiresAt: Math.floor(Date.now() / 1000) + 600
  })
).toString('base64url');
const signature = createHmac('sha256', env.SESSION_SECRET)
  .update(payload)
  .digest('base64url');
const cookie = `jishi_session=${payload}.${signature}`;
const baseUrl = process.env.API_URL ?? 'http://localhost:3002/api';

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${body?.message ?? '请求失败'}`);
  }
  return body;
}

const connection = await request('/admin/feishu/test-connection', {
  method: 'POST'
});
const sync = await request('/schedules/sync-feishu', { method: 'POST' });
const status = await request('/schedules/source-status');
const staff = await request('/schedules/monthly?month=2026-07&role=FIELD_CONTROL');
const anchors = await request('/schedules/monthly?month=2026-07&role=ANCHOR');
const augustStaff = await request('/schedules/monthly?month=2026-08&role=FIELD_CONTROL');
const augustAnchors = await request('/schedules/monthly?month=2026-08&role=ANCHOR');

console.log(
  JSON.stringify(
    {
      connection,
      sync,
      authority: status.dataAuthority,
      enabledTables: status.tables.filter((table) => table.enabled).map((table) => ({
        name: table.table_name,
        fieldMappings: table.field_mapping_count,
        lastSyncedAt: table.last_synced_at
      })),
      julyFieldControls: staff.people.length,
      julyAnchors: anchors.people.length,
      augustFieldControls: augustStaff.people.length,
      augustAnchors: augustAnchors.people.length
    },
    null,
    2
  )
);
await pool.end();
