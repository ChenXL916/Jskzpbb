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
const baseUrl = process.env.API_URL ?? 'http://127.0.0.1:3002/api';

async function request(cookie, path, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${body?.message ?? '请求失败'}`);
  }
  return { body, durationMs: Math.round(performance.now() - startedAt) };
}

try {
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
  const account = user.rows[0];
  if (!account || !env.SESSION_SECRET) {
    throw new Error('缺少可用开发者账号或会话密钥');
  }
  const payload = Buffer.from(
    JSON.stringify({
      userId: account.id,
      sessionVersion: account.session_version ?? 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600
    })
  ).toString('base64url');
  const signature = createHmac('sha256', env.SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  const cookie = `jishi_session=${payload}.${signature}`;

  const me = await request(cookie, '/auth/me');
  const writebackBefore = await request(
    cookie,
    '/admin/feishu/appointment-writeback/status'
  );
  const mapping = await request(
    cookie,
    '/admin/feishu/appointment-mapping/auto-configure',
    { method: 'POST' }
  );
  const drain = await request(
    cookie,
    '/admin/feishu/appointment-writeback/drain',
    { method: 'POST' }
  );
  const writebackAfter = await request(
    cookie,
    '/admin/feishu/appointment-writeback/status'
  );
  const rules = await request(cookie, '/admin/schedule-notifications/rules');
  const plans = await request(cookie, '/schedule-plans?month=2026-08');

  const database = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM feishu_field_mappings fm
       JOIN feishu_table_mappings tm ON tm.id=fm.table_mapping_id
       WHERE tm.business_type='MAKEUP_APPOINTMENTS' AND fm.enabled) AS appointment_field_mappings,
      (SELECT count(*)::int FROM sync_conflicts WHERE status='OPEN') AS open_sync_conflicts,
      (SELECT count(*)::int FROM schedule_plan_publications) AS plan_publications,
      (SELECT count(*)::int FROM makeup_appointments WHERE source_record_id IS NOT NULL) AS linked_appointments,
      (SELECT count(DISTINCT p.id)::int
       FROM people p JOIN person_roles r ON r.person_id=p.id
       WHERE r.role='MAKEUP_ARTIST' AND r.enabled AND p.archived_at IS NULL
         AND p.booking_allowed) AS active_makeup_artists,
      (SELECT count(DISTINCT p.id)::int
       FROM people p JOIN person_roles r ON r.person_id=p.id
       WHERE r.role='MAKEUP_ARTIST' AND r.enabled AND p.archived_at IS NULL
         AND p.booking_allowed AND p.login_allowed
         AND EXISTS (
           SELECT 1 FROM users u WHERE u.person_id=p.id AND u.disabled_at IS NULL
             AND (u.password_hash IS NOT NULL OR u.feishu_open_id IS NOT NULL)
         )) AS reachable_makeup_artists,
      (SELECT count(*)::int FROM room_field_controls WHERE enabled) AS active_field_control_bindings,
      (SELECT count(*)::int
       FROM live_sessions own
       JOIN live_sessions other ON own.id<other.id
        AND own.anchor_id=other.anchor_id
        AND own.starts_at<other.ends_at AND own.ends_at>other.starts_at
       WHERE own.source_type='FEISHU' AND other.source_type='FEISHU'
         AND own.status='SCHEDULED' AND other.status='SCHEDULED'
         AND own.cancelled_at IS NULL AND other.cancelled_at IS NULL
      ) AS formal_anchor_overlap_pairs
  `);
  const parseQuality = await pool.query(`
    SELECT role::text, parse_status::text, count(*)::int AS count
    FROM staff_daily_schedules
    WHERE source_type='FEISHU' AND cancelled_at IS NULL
    GROUP BY role, parse_status
    ORDER BY role, parse_status
  `);
  const unparsedShiftValues = await pool.query(`
    SELECT role::text, parse_status::text, raw_shift_value, count(*)::int AS count
    FROM staff_daily_schedules
    WHERE source_type='FEISHU' AND cancelled_at IS NULL
      AND parse_status<>'SUCCESS'
    GROUP BY role, parse_status, raw_shift_value
    ORDER BY count(*) DESC, role, raw_shift_value
    LIMIT 20
  `);

  console.log(
    JSON.stringify(
      {
        authenticated: me.body.roles?.includes('DEVELOPER') ?? false,
        mapping: {
          enabled: mapping.body.enabled,
          mappedFieldCount: mapping.body.mappedFields?.length ?? 0,
          missingRequired: mapping.body.missingRequired ?? [],
          durationMs: mapping.durationMs
        },
        writeback: {
          before: writebackBefore.body.outbox,
          drained: drain.body,
          after: writebackAfter.body.outbox,
          enabled: writebackAfter.body.enabled
        },
        notificationRules: rules.body.map((rule) => ({
          code: rule.code,
          weekday: rule.weekday,
          sendTime: rule.sendTime,
          enabled: rule.enabled,
          targetConfigured: rule.target?.configured ?? false
        })),
        planList: {
          count: Array.isArray(plans.body) ? plans.body.length : 0,
          durationMs: plans.durationMs
        },
        database: database.rows[0],
        parseQuality: parseQuality.rows,
        unparsedShiftValues: unparsedShiftValues.rows
      },
      null,
      2
    )
  );
} finally {
  await pool.end();
}
