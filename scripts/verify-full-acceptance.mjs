import { createHmac, randomUUID } from 'node:crypto';
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

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 30 });
const baseUrl = process.env.API_URL ?? 'http://localhost:3002/api';
const runId = `ACC-${Date.now()}-${randomUUID().slice(0, 8)}`;
const checks = [];

function record(name, passed, evidence) {
  checks.push({ name, passed, evidence: String(evidence).slice(0, 240) });
}

function expectStatus(name, response, expected) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  const passed = statuses.includes(response.status);
  record(
    name,
    passed,
    `${response.status} ${response.body?.message ?? response.body?.status ?? ''}`.trim()
  );
  return passed;
}

function signedCookie(userId, sessionVersion = 1) {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      sessionVersion,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 60
    })
  ).toString('base64url');
  const signature = createHmac('sha256', env.SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return `jishi_session=${payload}.${signature}`;
}

async function api(cookie, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {})
    }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function shanghaiDate(daysFromNow) {
  const value = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function atShanghai(date, time) {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

async function setupFixture() {
  const roles = {
    anchor: 'ANCHOR',
    anchorTwo: 'ANCHOR',
    artist: 'MAKEUP_ARTIST',
    artistTwo: 'MAKEUP_ARTIST',
    artistThree: 'MAKEUP_ARTIST',
    otherArtist: 'MAKEUP_ARTIST',
    control: 'FIELD_CONTROL',
    supervisor: 'LIVE_SUPERVISOR',
    talent: 'TALENT',
    director: 'DIRECTOR'
  };
  const people = {};
  const users = {};

  await pool.query('BEGIN');
  try {
    for (const [key, role] of Object.entries(roles)) {
      const personId = randomUUID();
      const userId = randomUUID();
      people[key] = personId;
      users[key] = userId;
      await pool.query(
        `
          INSERT INTO people(
            id, display_name, employee_no, login_allowed, booking_allowed,
            metadata
          ) VALUES ($1,$2,$3,true,true,$4)
        `,
        [
          personId,
          `验收专用-${key}-${runId.slice(-8)}`,
          `ACC-${key}-${runId.slice(-8)}`,
          JSON.stringify({ acceptance_run_id: runId })
        ]
      );
      await pool.query(
        `INSERT INTO person_roles(person_id, role) VALUES ($1,$2)`,
        [personId, role]
      );
      await pool.query(
        `
          INSERT INTO users(id, person_id, username, auth_source, password_hash)
          VALUES ($1,$2,$3,'LOCAL',$4)
        `,
        [
          userId,
          personId,
          `acc_${key}_${runId.slice(-8)}`,
          '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.'
        ]
      );
    }

    const room = randomUUID();
    const otherRoom = randomUUID();
    await pool.query(
      `
        INSERT INTO rooms(id,name,external_key,location)
        VALUES ($1,$2,$3,'验收区'),($4,$5,$6,'验收区')
      `,
      [
        room,
        `验收专用直播间-${runId}`,
        `${runId}:ROOM:1`,
        otherRoom,
        `验收专用未授权直播间-${runId}`,
        `${runId}:ROOM:2`
      ]
    );
    await pool.query(
      `
        INSERT INTO user_data_scopes(user_id,scope_type,scope_id,can_view,can_manage)
        VALUES ($1,'ROOM',$2,true,true)
      `,
      [users.control, room]
    );
    await pool.query('COMMIT');
    return { people, users, room, otherRoom };
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function seedStaffShiftDirect(personId, role, scheduleDate, startsAt, endsAt) {
  const id = randomUUID();
  const person = await pool.query(
    `SELECT display_name, employment_status FROM people WHERE id=$1`,
    [personId]
  );
  await pool.query(
    `
      INSERT INTO staff_daily_schedules(
        id, person_id, schedule_date, role, employment_status,
        raw_person_name, raw_shift_value, starts_at, ends_at,
        is_rest, is_leave, is_bookable, parse_status,
        source_table_id, source_record_id, source_date_field_id,
        source_date_field_name, raw_data, source_type, notes
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        false,false,true,'SUCCESS',
        'ACCEPTANCE_FEISHU',$10,$11,$11,$12::jsonb,'FEISHU',$13
      )
    `,
    [
      id,
      personId,
      scheduleDate,
      role,
      person.rows[0]?.employment_status ?? 'ACTIVE',
      person.rows[0]?.display_name ?? 'Acceptance fixture',
      'Acceptance direct prerequisite shift',
      startsAt,
      endsAt,
      id,
      scheduleDate,
      JSON.stringify({ acceptance_run_id: runId }),
      `${runId}:FEISHU-PREREQUISITE`
    ]
  );
  await pool.query(
    `
      INSERT INTO staff_schedule_segments(
        schedule_id, segment_index, starts_at, ends_at, bookable
      ) VALUES ($1,0,$2,$3,true)
    `,
    [id, startsAt, endsAt]
  );
  return id;
}

async function seedLiveSessionDirect(fixture, startsAt, endsAt) {
  const id = randomUUID();
  await pool.query(
    `
      INSERT INTO live_sessions(
        id, room_id, anchor_id, starts_at, ends_at, schedule_type,
        makeup_required, status, source_fingerprint, source_type, notes
      ) VALUES ($1,$2,$3,$4,$5,'LIVE',true,'SCHEDULED',$6,'FEISHU',$7)
    `,
    [
      id,
      fixture.room,
      fixture.people.anchor,
      startsAt,
      endsAt,
      `FEISHU:ACCEPTANCE:${id}`,
      `${runId}:FEISHU-PREREQUISITE`
    ]
  );
  await pool.query(
    `
      INSERT INTO room_field_controls(
        room_id, person_id, starts_at, ends_at, live_session_id, enabled
      ) VALUES ($1,$2,$3,$4,$5,true)
    `,
    [fixture.room, fixture.people.control, startsAt, endsAt, id]
  );
  return {
    status: 201,
    body: {
      id,
      room_id: fixture.room,
      anchor_id: fixture.people.anchor,
      starts_at: startsAt,
      ends_at: endsAt,
      makeup_required: true,
      status: 'SCHEDULED'
    }
  };
}

async function cleanupFixture() {
  const peopleResult = await pool.query(
    `SELECT id FROM people WHERE metadata->>'acceptance_run_id'=$1`,
    [runId]
  );
  const personIds = peopleResult.rows.map((row) => row.id);
  const roomResult = await pool.query(
    `SELECT id FROM rooms WHERE external_key LIKE $1`,
    [`${runId}:%`]
  );
  const roomIds = roomResult.rows.map((row) => row.id);
  if (!personIds.length && !roomIds.length) return;

  await pool.query('BEGIN');
  try {
    const appointments = await pool.query(
      `
        SELECT id FROM makeup_appointments
        WHERE requester_id=ANY($1::uuid[])
           OR subject_person_id=ANY($1::uuid[])
           OR makeup_artist_id=ANY($1::uuid[])
      `,
      [personIds]
    );
    const appointmentIds = appointments.rows.map((row) => row.id);
    const sessions = await pool.query(
      `
        SELECT id FROM live_sessions
        WHERE anchor_id=ANY($1::uuid[]) OR room_id=ANY($2::uuid[])
      `,
      [personIds, roomIds]
    );
    const sessionIds = sessions.rows.map((row) => row.id);
    const schedules = await pool.query(
      `SELECT id FROM staff_daily_schedules WHERE person_id=ANY($1::uuid[])`,
      [personIds]
    );
    const scheduleIds = schedules.rows.map((row) => row.id);
    const users = await pool.query(
      `SELECT id FROM users WHERE person_id=ANY($1::uuid[])`,
      [personIds]
    );
    const userIds = users.rows.map((row) => row.id);
    const resourceIds = [...appointmentIds, ...sessionIds, ...scheduleIds];

    await pool.query(
      `
        DELETE FROM notification_outbox
        WHERE recipient_person_id=ANY($1::uuid[])
           OR aggregate_id=ANY($2::uuid[])
      `,
      [personIds, resourceIds]
    );
    await pool.query(
      `DELETE FROM feishu_write_outbox WHERE aggregate_id=ANY($1::uuid[])`,
      [appointmentIds]
    );
    await pool.query(
      `
        DELETE FROM operation_logs
        WHERE actor_id=ANY($1::uuid[]) OR resource_id=ANY($2::uuid[])
      `,
      [personIds, resourceIds]
    );
    await pool.query(
      `
        DELETE FROM risk_items
        WHERE appointment_id=ANY($1::uuid[])
           OR live_session_id=ANY($2::uuid[])
           OR room_id=ANY($3::uuid[])
           OR person_id=ANY($4::uuid[])
           OR owner_id=ANY($4::uuid[])
      `,
      [appointmentIds, sessionIds, roomIds, personIds]
    );
    await pool.query(
      `DELETE FROM makeup_appointments WHERE id=ANY($1::uuid[])`,
      [appointmentIds]
    );
    await pool.query(
      `DELETE FROM live_sessions WHERE id=ANY($1::uuid[])`,
      [sessionIds]
    );
    await pool.query(
      `DELETE FROM staff_daily_schedules WHERE id=ANY($1::uuid[])`,
      [scheduleIds]
    );
    await pool.query(`DELETE FROM idempotency_keys WHERE user_id=ANY($1::uuid[])`, [
      userIds
    ]);
    await pool.query(`DELETE FROM users WHERE id=ANY($1::uuid[])`, [userIds]);
    await pool.query(`DELETE FROM people WHERE id=ANY($1::uuid[])`, [personIds]);
    await pool.query(`DELETE FROM rooms WHERE id=ANY($1::uuid[])`, [roomIds]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function run() {
  const fixture = await setupFixture();
  const admin = await pool.query(
    `
      SELECT u.id, u.session_version
      FROM users u
      JOIN people p ON p.id=u.person_id
      JOIN person_roles role ON role.person_id=p.id AND role.enabled
      WHERE p.login_allowed AND u.disabled_at IS NULL
        AND role.role IN ('ADMIN','DEVELOPER')
      ORDER BY u.created_at
      LIMIT 1
    `
  );
  const adminUserId = admin.rows[0]?.id;
  if (!adminUserId) throw new Error('没有管理员/开发者账号可执行验收');

  const cookies = Object.fromEntries(
    Object.entries(fixture.users).map(([key, id]) => [key, signedCookie(id)])
  );
  cookies.admin = signedCookie(
    adminUserId,
    admin.rows[0]?.session_version ?? 1
  );
  const date = shanghaiDate(1);
  const month = date.slice(0, 7);
  const shiftStart = atShanghai(date, '08:00');
  const shiftEnd = atShanghai(date, '22:00');
  const liveStart = atShanghai(date, '18:00');
  const liveEnd = atShanghai(date, '20:00');

  const unauthenticated = await api('', '/admin/roles');
  expectStatus('未登录访问管理接口被拒绝', unauthenticated, 401);

  for (const [key, role] of [
    ['talent', 'TALENT'],
    ['director', 'DIRECTOR'],
    ['anchor', 'ANCHOR'],
    ['artist', 'MAKEUP_ARTIST'],
    ['control', 'FIELD_CONTROL'],
    ['supervisor', 'LIVE_SUPERVISOR']
  ]) {
    const me = await api(cookies[key], '/auth/me');
    expectStatus(`${role} 会话可识别`, me, 200);
    record(
      `${role} 返回正确角色`,
      Array.isArray(me.body?.roles) && me.body.roles.includes(role),
      JSON.stringify(me.body?.roles ?? [])
    );
  }

  expectStatus(
    '达人不能读取人员管理',
    await api(cookies.talent, '/admin/people'),
    403
  );
  expectStatus(
    '编导不能读取综合排班',
    await api(cookies.director, `/schedules/monthly?month=${month}`),
    403
  );
  expectStatus(
    '达人不能读取本人排班',
    await api(cookies.talent, `/me/schedule?month=${month}`),
    403
  );
  for (const [key, label] of [
    ['anchor', '主播'],
    ['artist', '化妆师'],
    ['control', '场控']
  ]) {
    expectStatus(
      `${label}可读取本人排班`,
      await api(cookies[key], `/me/schedule?month=${month}`),
      200
    );
    expectStatus(
      `${label}不能读取综合排班`,
      await api(cookies[key], `/schedules/monthly?month=${month}`),
      403
    );
  }
  expectStatus(
    '直播主管可读取排班管理选项',
    await api(cookies.supervisor, '/schedules/manage/options'),
    200
  );
  expectStatus(
    '主播不能读取达人预约台',
    await api(
      cookies.anchor,
      `/appointments/requester-dashboard?date=${date}`
    ),
    403
  );
  expectStatus(
    '场控不能读取未授权直播间',
    await api(
      cookies.control,
      `/control/rooms/${fixture.otherRoom}/makeup-board`
    ),
    403
  );
  expectStatus(
    '直播主管可读取运营总览',
    await api(cookies.supervisor, '/management/dashboard'),
    200
  );

  const unscheduledSession = await api(
    cookies.admin,
    '/schedules/manage/live-sessions',
    {
      method: 'POST',
      body: JSON.stringify({
        roomId: fixture.otherRoom,
        anchorId: fixture.people.anchorTwo,
        fieldControlId: fixture.people.control,
        startsAt: liveStart,
        endsAt: liveEnd,
        scheduleType: 'LIVE',
        makeupRequired: false,
        notes: `${runId}:UNSCHEDULED-RESOURCE-CHECK`
      })
    }
  );
  expectStatus(
    'Live session rejects anchor or field-control without a staff shift',
    unscheduledSession,
    [400, 409]
  );
  if (unscheduledSession.status === 201 && unscheduledSession.body?.id) {
    await api(
      cookies.admin,
      `/schedules/manage/live-sessions/${unscheduledSession.body.id}/cancel`,
      { method: 'POST' }
    );
  }

  const shiftIds = [];
  for (const key of [
    'artist',
    'artistTwo',
    'artistThree',
    'otherArtist',
    'anchor',
    'anchorTwo',
    'control'
  ]) {
    const role = key.startsWith('artist') || key === 'otherArtist'
      ? 'MAKEUP_ARTIST'
      : key.startsWith('anchor')
        ? 'ANCHOR'
        : 'FIELD_CONTROL';
    const created = await api(cookies.admin, '/schedules/manage/staff-shifts', {
      method: 'POST',
      body: JSON.stringify({
        personId: fixture.people[key],
        role,
        scheduleDate: date,
        startsAt: shiftStart,
        endsAt: shiftEnd,
        rawShiftValue: '验收专用班次',
        isRest: false,
        isLeave: false,
        notes: runId
      })
    });
    expectStatus(`本地创建 ${key} 正式班次被主权边界阻止`, created, 409);
    shiftIds.push(
      await seedStaffShiftDirect(
        fixture.people[key],
        role,
        date,
        shiftStart,
        shiftEnd
      )
    );
  }

  const livePayload = {
    roomId: fixture.room,
    anchorId: fixture.people.anchor,
    fieldControlId: fixture.people.control,
    startsAt: liveStart,
    endsAt: liveEnd,
    scheduleType: 'LIVE',
    makeupRequired: true,
    notes: runId
  };
  let liveSession = await api(cookies.admin, '/schedules/manage/live-sessions', {
    method: 'POST',
    body: JSON.stringify(livePayload)
  });
  expectStatus('本地创建正式直播场次被主权边界阻止', liveSession, 409);
  liveSession = await seedLiveSessionDirect(fixture, liveStart, liveEnd);

  const conflictSession = await api(
    cookies.admin,
    '/schedules/manage/live-sessions',
    {
      method: 'POST',
      body: JSON.stringify({
        ...livePayload,
        anchorId: fixture.people.anchorTwo
      })
    }
  );
  expectStatus('本地重叠场次写入被正式排班主权边界阻止', conflictSession, 409);

  const duplicateShift = await api(
    cookies.admin,
    '/schedules/manage/staff-shifts',
    {
      method: 'POST',
      body: JSON.stringify({
        personId: fixture.people.artist,
        role: 'MAKEUP_ARTIST',
        scheduleDate: date,
        startsAt: shiftStart,
        endsAt: shiftEnd,
        rawShiftValue: '重复验收班次',
        isRest: false,
        isLeave: false
      })
    }
  );
  expectStatus('本地重复班次写入被正式排班主权边界阻止', duplicateShift, 409);

  const requesterDashboard = await api(
    cookies.talent,
    `/appointments/requester-dashboard?date=${date}`
  );
  expectStatus('达人读取公开可约时间', requesterDashboard, 200);
  const publicArtist = requesterDashboard.body?.artists?.find(
    (item) => item.makeupArtistId === fixture.people.artist
  );
  record(
    '达人可看到验收化妆师预计时段',
    Boolean(publicArtist?.slots?.length),
    publicArtist?.slots?.[0]?.startsAt ?? '无时段'
  );

  const requesterStart = atShanghai(date, '09:00');
  const requesterPayload = {
    makeupArtistId: fixture.people.artist,
    plannedStartAt: requesterStart,
    serviceTypeCode: 'FULL_LIVE_LOOK',
    location: '验收妆造间',
    note: runId
  };
  const requesterKey = `${runId}:TALENT:BOOK`;
  const requesterBooking = await api(cookies.talent, '/appointments/requester-book', {
    method: 'POST',
    headers: { 'idempotency-key': requesterKey },
    body: JSON.stringify(requesterPayload)
  });
  expectStatus('达人创建本人预约', requesterBooking, 201);
  const requesterBookingReplay = await api(
    cookies.talent,
    '/appointments/requester-book',
    {
      method: 'POST',
      headers: { 'idempotency-key': requesterKey },
      body: JSON.stringify(requesterPayload)
    }
  );
  expectStatus('重复幂等请求返回原预约', requesterBookingReplay, 201);
  record(
    '幂等请求没有重复建单',
    requesterBooking.body?.id && requesterBooking.body.id === requesterBookingReplay.body?.id,
    `${requesterBooking.body?.id ?? '无'} / ${requesterBookingReplay.body?.id ?? '无'}`
  );

  const appointmentId = requesterBooking.body?.id;
  if (appointmentId) {
    expectStatus(
      '达人无权取消预约',
      await api(cookies.talent, `/appointments/${appointmentId}/cancel`, {
        method: 'PATCH'
      }),
      403
    );
    expectStatus(
      '其他化妆师不能开始该任务',
      await api(cookies.otherArtist, `/appointments/${appointmentId}/start`, {
        method: 'PATCH'
      }),
      409
    );
    expectStatus(
      '未开始不能直接完成',
      await api(cookies.artist, `/appointments/${appointmentId}/complete`, {
        method: 'PATCH'
      }),
      409
    );
    expectStatus(
      '所属化妆师开始妆造',
      await api(cookies.artist, `/appointments/${appointmentId}/start`, {
        method: 'PATCH'
      }),
      200
    );
    const completed = await api(
      cookies.artist,
      `/appointments/${appointmentId}/complete`,
      { method: 'PATCH' }
    );
    expectStatus('所属化妆师完成妆造', completed, 200);
    record('完成状态正确', completed.body?.status === 'COMPLETED', completed.body?.status);
  }

  if (liveSession.body?.id) {
    const recommendation = await api(
      cookies.anchor,
      `/appointments/recommendations?liveSessionId=${liveSession.body.id}`
    );
    expectStatus('主播获得直播关联妆造推荐', recommendation, 200);
    const selected = recommendation.body?.recommendations?.find(
      (item) => item.makeupArtistId === fixture.people.artistTwo
    );
    record(
      '推荐包含班次覆盖的化妆师',
      Boolean(selected),
      recommendation.body?.recommendations?.length ?? 0
    );
    const booked = await api(cookies.anchor, '/appointments/quick-book', {
      method: 'POST',
      headers: { 'idempotency-key': `${runId}:ANCHOR:BOOK` },
      body: JSON.stringify({
        liveSessionId: liveSession.body.id,
        makeupArtistId: fixture.people.artistTwo,
        serviceTypeCode: 'FULL_LIVE_LOOK'
      })
    });
    expectStatus('主播一键预约', booked, 201);
    if (booked.body?.id) {
      expectStatus(
        '主播预约由对应化妆师开始',
        await api(cookies.artistTwo, `/appointments/${booked.body.id}/start`, {
          method: 'PATCH'
        }),
        200
      );
      expectStatus(
        '主播预约由对应化妆师完成',
        await api(cookies.artistTwo, `/appointments/${booked.body.id}/complete`, {
          method: 'PATCH'
        }),
        200
      );
    }
    const controlBoard = await api(
      cookies.control,
      `/control/rooms/${fixture.room}/makeup-board`
    );
    expectStatus('场控读取授权直播间妆造看板', controlBoard, 200);
  }

  const concurrentPayload = {
    makeupArtistId: fixture.people.artistThree,
    plannedStartAt: atShanghai(date, '11:00'),
    serviceTypeCode: 'FULL_LIVE_LOOK',
    location: '验收并发妆造间',
    note: runId
  };
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      api(cookies.director, '/appointments/requester-book', {
        method: 'POST',
        headers: { 'idempotency-key': `${runId}:CONCURRENT:${index}` },
        body: JSON.stringify(concurrentPayload)
      })
    )
  );
  const successes = concurrent.filter((item) => item.status === 201);
  const rejected = concurrent.filter((item) => item.status === 409);
  record(
    '20并发同资源同时间仅1单成功',
    successes.length === 1 && rejected.length === 19,
    `成功 ${successes.length} / 冲突 ${rejected.length}`
  );

  const evidence = await pool.query(
    `
      SELECT
        (SELECT count(*)::int FROM appointment_status_logs log
         JOIN makeup_appointments appointment ON appointment.id=log.appointment_id
         WHERE appointment.requester_id=ANY($1::uuid[])) AS status_logs,
        (SELECT count(*)::int FROM notification_outbox outbox
         WHERE outbox.recipient_person_id=ANY($1::uuid[])) AS notification_outbox,
        (SELECT count(*)::int FROM feishu_write_outbox outbox
         JOIN makeup_appointments appointment ON appointment.id=outbox.aggregate_id
         WHERE appointment.requester_id=ANY($1::uuid[])) AS feishu_outbox,
        (SELECT value #>> '{}'
         FROM system_settings
         WHERE key='schedule.data_authority') AS data_authority,
        (SELECT count(*)::int FROM operation_logs log
         WHERE log.actor_id=ANY($1::uuid[])
            OR log.resource_id IN (
              SELECT id FROM makeup_appointments
              WHERE requester_id=ANY($1::uuid[])
                 OR subject_person_id=ANY($1::uuid[])
                 OR makeup_artist_id=ANY($1::uuid[])
            )) AS operation_logs
    `,
    [Object.values(fixture.people)]
  );
  const counts = evidence.rows[0];
  record('预约状态日志已落库', counts.status_logs >= 6, counts.status_logs);
  record('站内/群通知 Outbox 已落库', counts.notification_outbox >= 4, counts.notification_outbox);
  record(
    '预约写入符合当前数据主权模式',
    counts.data_authority === 'LOCAL_DATABASE'
      ? counts.feishu_outbox === 0
      : counts.feishu_outbox >= 3,
    `${counts.data_authority ?? 'UNKNOWN'} / Feishu Outbox ${counts.feishu_outbox}`
  );
  record('预约与状态操作审计日志已落库', counts.operation_logs >= 4, counts.operation_logs);
}

try {
  await run();
} catch (error) {
  record('验收脚本执行', false, error instanceof Error ? error.stack ?? error.message : error);
} finally {
  try {
    await cleanupFixture();
    record('验收数据清理', true, runId);
  } catch (error) {
    record('验收数据清理', false, error instanceof Error ? error.message : error);
  }
  await pool.end();
}

console.table(checks);
const failed = checks.filter((item) => !item.passed);
console.log(JSON.stringify({ runId, total: checks.length, passed: checks.length - failed.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
