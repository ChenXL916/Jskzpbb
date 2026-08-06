import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';

loadEnv({ path: join(__dirname, '../../../.env') });

describe('database appointment concurrency', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
  const personIds: string[] = [];
  const sessionIds: string[] = [];
  const appointmentIds: string[] = [];
  const roomId = randomUUID();
  const artistId = randomUUID();
  const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  let serviceTypeId: string;

  beforeAll(async () => {
    await pool.query(`INSERT INTO rooms(id,name) VALUES ($1,$2)`, [
      roomId,
      `并发测试直播间-${roomId}`
    ]);
    await pool.query(
      `INSERT INTO people(id,display_name) VALUES ($1,$2)`,
      [artistId, `并发测试化妆师-${artistId}`]
    );
    personIds.push(artistId);
    await pool.query(
      `INSERT INTO person_roles(person_id,role) VALUES ($1,'MAKEUP_ARTIST')`,
      [artistId]
    );
    serviceTypeId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM makeup_service_types WHERE code='FULL_LIVE_LOOK'`
      )
    ).rows[0]!.id;

    for (let index = 0; index < 20; index += 1) {
      const anchorId = randomUUID();
      const sessionId = randomUUID();
      personIds.push(anchorId);
      sessionIds.push(sessionId);
      await pool.query(
        `INSERT INTO people(id,display_name) VALUES ($1,$2)`,
        [anchorId, `并发主播-${index}-${anchorId}`]
      );
      await pool.query(
        `
          INSERT INTO live_sessions(
            id,room_id,anchor_id,starts_at,ends_at,source_fingerprint
          ) VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
          sessionId,
          roomId,
          anchorId,
          new Date(endsAt.getTime() + 30 * 60 * 1000),
          new Date(endsAt.getTime() + 3 * 60 * 60 * 1000),
          `test-${sessionId}`
        ]
      );
    }
  });

  afterAll(async () => {
    if (appointmentIds.length) {
      await pool.query(`DELETE FROM makeup_appointments WHERE id=ANY($1::uuid[])`, [
        appointmentIds
      ]);
    }
    await pool.query(`DELETE FROM live_sessions WHERE id=ANY($1::uuid[])`, [sessionIds]);
    await pool.query(`DELETE FROM person_roles WHERE person_id=ANY($1::uuid[])`, [
      personIds
    ]);
    await pool.query(`DELETE FROM people WHERE id=ANY($1::uuid[])`, [personIds]);
    await pool.query(`DELETE FROM rooms WHERE id=$1`, [roomId]);
    await pool.end();
  });

  it('allows exactly one of 20 simultaneous bookings for one artist and time', async () => {
    const attempts = sessionIds.map(async (sessionId, index) => {
      const id = randomUUID();
      appointmentIds.push(id);
      return pool.query(
        `
          INSERT INTO makeup_appointments(
            id,appointment_no,makeup_date,subject_type,subject_person_id,
            anchor_id,live_session_id,room_id,
            requester_id,requester_role,makeup_artist_id,service_type_id,
            planned_start_at,planned_end_at,planned_minutes,location
          )
          VALUES ($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
            'ANCHOR',$4,$4,$5,$6,$4,'ANCHOR',$7,$8,$3,$9,60,'并发测试')
        `,
        [
          id,
          `TEST-${randomUUID().slice(0, 8)}-${index}`,
          startsAt,
          personIds[index + 1],
          sessionId,
          roomId,
          artistId,
          serviceTypeId,
          endsAt
        ]
      );
    });
    const results = await Promise.allSettled(attempts);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    if (successes.length !== 1) {
      const reasons = failures.slice(0, 3).map((result) =>
        result.status === 'rejected' && result.reason instanceof Error
          ? result.reason.message
          : JSON.stringify(result)
      );
      throw new Error(
        `expected one success, received ${successes.length}; sample failures: ${reasons.join(' | ')}`
      );
    }
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(19);
  });
});
