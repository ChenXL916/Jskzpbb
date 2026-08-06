import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import {
  AppointmentStatus,
  CurrentUser,
  MakeupRecommendation,
  PersonRole,
  RequesterMakeupArtistAvailability
} from '@jishi/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseError, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ScheduleNotificationService } from '../outbox/schedule-notification.service';
import {
  AppointmentExceptionDto,
  ManualTaskDto,
  QuickBookDto,
  RequesterBookDto,
  RescheduleAppointmentDto
} from './appointment.dto';
import { AppointmentStateMachineService } from './appointment-state-machine.service';
import {
  anchorAppointmentWindow,
  isGeneralRequesterDurationAllowed
} from './appointment-time-policy';
import { RedisLockService } from './redis-lock.service';

interface SessionRow {
  id: string;
  anchor_id: string;
  room_id: string;
  room_name: string;
  anchor_name: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  has_schedule_conflict: boolean;
}

interface ServiceTypeRow {
  id: string;
  code: string;
  name: string;
  default_minutes: number;
  buffer_after_minutes: number;
}

interface RecommendationRow {
  id: string;
  display_name: string;
  active_minutes: number;
  task_count: number;
}

interface AppointmentDbRow extends Record<string, unknown> {
  id: string;
  anchor_id: string | null;
  subject_person_id: string;
  subject_type: 'ANCHOR' | 'TALENT' | 'DIRECTOR';
  makeup_artist_id: string;
  room_id: string | null;
  data_version: number;
  status: AppointmentStatus;
}

interface RequesterArtistRow {
  id: string;
  display_name: string;
}

interface AvailabilityWindowRow {
  makeup_artist_id: string;
  starts_at: Date;
  ends_at: Date;
}

interface AvailabilityBlockRow {
  makeup_artist_id: string;
  starts_at: Date;
  ends_at: Date;
  block_type: string;
}

@Injectable()
export class AppointmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly locks: RedisLockService,
    private readonly stateMachine: AppointmentStateMachineService,
    private readonly realtime: RealtimeService,
    private readonly scheduleNotifications: ScheduleNotificationService
  ) {}

  async recommendation(
    user: CurrentUser,
    liveSessionId: string,
    serviceTypeCode = 'FULL_LIVE_LOOK'
  ): Promise<{
    liveSession: SessionRow;
    recommendations: MakeupRecommendation[];
  }> {
    const session = await this.getSession(liveSessionId);
    this.assertSessionAccess(user, session);
    if (session.has_schedule_conflict) {
      throw new ConflictException(
        '该主播直播时段存在跨直播间排班冲突，请主管先在飞书修正后再预约'
      );
    }
    if (session.status !== 'SCHEDULED' || session.starts_at <= new Date()) {
      throw new UnprocessableEntityException('直播班次已取消、变更或已经开始');
    }
    const [service, leadMinutes, fullMakeupMinutes] = await Promise.all([
      this.getServiceType(serviceTypeCode),
      this.integerSetting('booking.anchor_lead_minutes', 60),
      this.integerSetting('booking.full_makeup_minutes', 40)
    ]);
    const durationMinutes =
      service.code === 'FULL_LIVE_LOOK'
        ? fullMakeupMinutes
        : service.default_minutes;
    let window: ReturnType<typeof anchorAppointmentWindow>;
    try {
      window = anchorAppointmentWindow(
        session.starts_at,
        durationMinutes,
        leadMinutes
      );
    } catch {
      throw new UnprocessableEntityException(
        '当前妆造类型无法在开播前的预约窗口内完成'
      );
    }
    const { startsAt: start, endsAt: end, remainingBufferMinutes } = window;
    if (start <= new Date()) {
      throw new UnprocessableEntityException(
        `主播妆造须在开播前${leadMinutes}分钟开始，当前已过最晚预约时间，不能临时预约`
      );
    }

    const candidates = await this.db.query<RecommendationRow>(
      `
        SELECT p.id, p.display_name,
               COALESCE(sum(
                 EXTRACT(EPOCH FROM (a.planned_end_at-a.planned_start_at))/60
               ) FILTER (WHERE a.status IN (
                 'BOOKED','IN_PROGRESS','RESCHEDULE_REQUIRED',
                 'REASSIGN_REQUIRED','EXCEPTION'
               )), 0)::int AS active_minutes,
               count(a.id) FILTER (WHERE a.status IN (
                 'BOOKED','IN_PROGRESS','RESCHEDULE_REQUIRED',
                 'REASSIGN_REQUIRED','EXCEPTION'
               ))::int AS task_count
        FROM people p
        JOIN person_roles pr ON pr.person_id=p.id
          AND pr.role='MAKEUP_ARTIST' AND pr.enabled
        JOIN staff_daily_schedules s ON s.person_id=p.id
          AND s.role='MAKEUP_ARTIST' AND s.is_bookable
          AND s.source_type='FEISHU'
          AND s.parse_status='SUCCESS'
          AND s.starts_at <= $1 AND s.ends_at >= $2
          AND (
            NOT EXISTS (
              SELECT 1 FROM staff_schedule_segments configured
              WHERE configured.schedule_id=s.id
            )
            OR EXISTS (
              SELECT 1 FROM staff_schedule_segments segment
              WHERE segment.schedule_id=s.id AND segment.bookable
                AND segment.starts_at <= $1 AND segment.ends_at >= $2
            )
          )
        LEFT JOIN makeup_appointments a ON a.makeup_artist_id=p.id
          AND a.source_type<>'FEISHU'
          AND (a.planned_start_at AT TIME ZONE 'Asia/Shanghai')::date =
              ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
        WHERE p.archived_at IS NULL AND p.booking_allowed
          AND p.login_allowed
          AND EXISTS (
            SELECT 1 FROM users artist_user
            WHERE artist_user.person_id=p.id
              AND artist_user.disabled_at IS NULL
              AND (
                artist_user.password_hash IS NOT NULL
                OR artist_user.feishu_open_id IS NOT NULL
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM makeup_artist_availability av
            WHERE av.makeup_artist_id=p.id AND NOT av.bookable
              AND av.starts_at < $2 AND av.ends_at > $1
          )
          AND NOT EXISTS (
            SELECT 1 FROM person_temporary_statuses temporary
            WHERE temporary.person_id=p.id
              AND temporary.cancelled_at IS NULL
              AND temporary.status_type IN ('BREAK','LEAVE','UNAVAILABLE','TRAINING')
              AND temporary.starts_at < $2 AND temporary.ends_at > $1
          )
          AND NOT EXISTS (
            SELECT 1 FROM makeup_appointments conflict
            WHERE conflict.makeup_artist_id=p.id
              AND conflict.source_type<>'FEISHU'
              AND conflict.status IN (
                'BOOKED','IN_PROGRESS','RESCHEDULE_REQUIRED',
                'REASSIGN_REQUIRED','EXCEPTION'
              )
              AND conflict.planned_start_at < $2
              AND conflict.planned_end_at > $1
          )
        GROUP BY p.id
        ORDER BY task_count, active_minutes, p.display_name
      `,
      [start.toISOString(), end.toISOString()]
    );

    return {
      liveSession: session,
      recommendations: candidates.rows.map((artist, index) => ({
        makeupArtistId: artist.id,
        makeupArtistName: artist.display_name,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        reason:
          index === 0
            ? `开播前${leadMinutes}分钟开始，预计${durationMinutes}分钟，预留${remainingBufferMinutes}分钟且当日负载最低`
            : `班次覆盖且无冲突，完成后距开播${remainingBufferMinutes}分钟`,
        score: Math.max(1, 100 - artist.task_count * 8 - artist.active_minutes / 30)
      }))
    };
  }

  async requesterDashboard(
    user: CurrentUser,
    date: string,
    serviceTypeCode = 'GENERAL_MAKEUP'
  ) {
    const service = await this.getServiceType(serviceTypeCode);
    this.assertGeneralRequesterService(service);
    const { start: dayStart, end: dayEnd } = this.dayBounds(date);
    const [artists, windows, blocks, services, appointments] =
      await Promise.all([
        this.db.query<RequesterArtistRow>(
          `
            SELECT p.id, p.display_name
            FROM people p
            JOIN person_roles role ON role.person_id=p.id
              AND role.role='MAKEUP_ARTIST' AND role.enabled
            WHERE p.archived_at IS NULL
              AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
              AND p.booking_allowed
              AND p.login_allowed
              AND EXISTS (
                SELECT 1 FROM users artist_user
                WHERE artist_user.person_id=p.id
                  AND artist_user.disabled_at IS NULL
                  AND (
                    artist_user.password_hash IS NOT NULL
                    OR artist_user.feishu_open_id IS NOT NULL
                  )
              )
            ORDER BY p.display_name
          `
        ),
        this.db.query<AvailabilityWindowRow>(
          `
            SELECT schedule.person_id AS makeup_artist_id,
                   COALESCE(segment.starts_at, schedule.starts_at) AS starts_at,
                   COALESCE(segment.ends_at, schedule.ends_at) AS ends_at
            FROM staff_daily_schedules schedule
            LEFT JOIN staff_schedule_segments segment
              ON segment.schedule_id=schedule.id AND segment.bookable
            WHERE schedule.schedule_date=$1::date
              AND schedule.role='MAKEUP_ARTIST'
              AND schedule.source_type='FEISHU'
              AND schedule.is_bookable
              AND NOT schedule.is_rest
              AND NOT schedule.is_leave
              AND schedule.parse_status='SUCCESS'
              AND schedule.cancelled_at IS NULL
              AND schedule.starts_at IS NOT NULL
              AND schedule.ends_at IS NOT NULL
              AND (
                segment.id IS NOT NULL
                OR NOT EXISTS (
                  SELECT 1 FROM staff_schedule_segments configured
                  WHERE configured.schedule_id=schedule.id
                )
              )
            ORDER BY starts_at
          `,
          [date]
        ),
        this.db.query<AvailabilityBlockRow>(
          `
            SELECT appointment.makeup_artist_id,
                   appointment.planned_start_at AS starts_at,
                   appointment.planned_end_at AS ends_at,
                   'APPOINTMENT:' || appointment.status::text AS block_type
            FROM makeup_appointments appointment
            WHERE appointment.planned_start_at < $2
              AND appointment.planned_end_at > $1
              AND appointment.source_type<>'FEISHU'
              AND appointment.status IN (
                'BOOKED','IN_PROGRESS','RESCHEDULE_REQUIRED',
                'REASSIGN_REQUIRED','EXCEPTION'
              )
            UNION ALL
            SELECT availability.makeup_artist_id,
                   availability.starts_at,
                   availability.ends_at,
                   'AVAILABILITY' AS block_type
            FROM makeup_artist_availability availability
            WHERE NOT availability.bookable
              AND availability.starts_at < $2
              AND availability.ends_at > $1
            UNION ALL
            SELECT temporary.person_id AS makeup_artist_id,
                   temporary.starts_at,
                   temporary.ends_at,
                   temporary.status_type AS block_type
            FROM person_temporary_statuses temporary
            WHERE temporary.cancelled_at IS NULL
              AND temporary.status_type IN (
                'BREAK','LEAVE','UNAVAILABLE','TRAINING'
              )
              AND temporary.starts_at < $2
              AND temporary.ends_at > $1
          `,
          [dayStart.toISOString(), dayEnd.toISOString()]
        ),
        this.db.query<{
          code: string;
          name: string;
          default_minutes: number;
        }>(
          `
            SELECT code, name, default_minutes
            FROM makeup_service_types
            WHERE enabled
              AND default_minutes BETWEEN 30 AND 40
              AND code<>'FULL_LIVE_LOOK'
            ORDER BY default_minutes, name
          `
        ),
        this.db.query(
          `
            SELECT appointment.id, appointment.appointment_no,
                   appointment.status, appointment.subject_type,
                   appointment.planned_start_at, appointment.planned_end_at,
                   appointment.location,
                   artist.display_name AS makeup_artist_name
            FROM makeup_appointments appointment
            JOIN people artist ON artist.id=appointment.makeup_artist_id
            WHERE (
                appointment.requester_id=$1
                OR appointment.subject_person_id=$1
              )
              AND appointment.source_type<>'FEISHU'
              AND appointment.planned_end_at >= now()-interval '30 days'
            ORDER BY appointment.planned_start_at DESC
            LIMIT 50
          `,
          [user.personId]
        )
      ]);

    const now = new Date();
    const blocksByArtist = new Map<string, AvailabilityBlockRow[]>();
    for (const block of blocks.rows) {
      blocksByArtist.set(block.makeup_artist_id, [
        ...(blocksByArtist.get(block.makeup_artist_id) ?? []),
        block
      ]);
    }
    const windowsByArtist = new Map<string, AvailabilityWindowRow[]>();
    for (const window of windows.rows) {
      windowsByArtist.set(window.makeup_artist_id, [
        ...(windowsByArtist.get(window.makeup_artist_id) ?? []),
        window
      ]);
    }

    const availability: RequesterMakeupArtistAvailability[] = artists.rows.map(
      (artist) => {
        const artistWindows = windowsByArtist.get(artist.id) ?? [];
        const artistBlocks = blocksByArtist.get(artist.id) ?? [];
        const slots = this.buildAvailabilitySlots(
          artistWindows,
          artistBlocks,
          service.default_minutes,
          now
        );
        const currentBlock = this.currentAvailabilityBlock(artistBlocks, now);
        const onDuty = artistWindows.some(
          (window) => window.starts_at <= now && window.ends_at > now
        );
        const publicStatus = this.publicRequesterStatus(
          currentBlock?.block_type,
          onDuty,
          slots[0]?.startsAt,
          now
        );
        return {
          makeupArtistId: artist.id,
          makeupArtistName: artist.display_name,
          publicStatus,
          ...(currentBlock ? { statusUntil: currentBlock.ends_at.toISOString() } : {}),
          ...(slots[0] ? { nextAvailableAt: slots[0].startsAt } : {}),
          slots
        };
      }
    );

    return {
      date,
      generatedAt: now.toISOString(),
      serviceType: {
        code: service.code,
        name: service.name,
        defaultMinutes: service.default_minutes
      },
      services: services.rows.map((item) => ({
        code: item.code,
        name: item.name,
        defaultMinutes: item.default_minutes
      })),
      artists: availability,
      appointments: appointments.rows
    };
  }

  async requesterBook(
    user: CurrentUser,
    dto: RequesterBookDto,
    idempotencyKey: string
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new UnprocessableEntityException(
        '预约必须提供有效 Idempotency-Key'
      );
    }
    const subjectType = this.requesterSubjectRole(user);
    const serviceCode = dto.serviceTypeCode ?? 'GENERAL_MAKEUP';
    const service = await this.getServiceType(serviceCode);
    this.assertGeneralRequesterService(service);
    const start = new Date(dto.plannedStartAt);
    const end = new Date(start.getTime() + service.default_minutes * 60_000);
    if (!Number.isFinite(start.getTime()) || start <= new Date()) {
      throw new UnprocessableEntityException('请选择尚未开始的可预约时间');
    }

    const lock = await this.locks.acquire(
      `booking:${dto.makeupArtistId}:${start.toISOString()}`
    );
    if (!lock) throw new ConflictException('该时间正在被其他人预约，请重试');
    try {
      const appointment = await this.db.transaction(async (client) => {
        const requestHash = createHash('sha256')
          .update(JSON.stringify(dto))
          .digest('hex');
        const claimed = await client.query(
          `
            INSERT INTO idempotency_keys(
              key, user_id, operation, request_hash, expires_at
            )
            VALUES ($1,$2,'REQUESTER_BOOK',$3,now()+interval '24 hours')
            ON CONFLICT (key) DO NOTHING
            RETURNING key
          `,
          [idempotencyKey, user.id, requestHash]
        );
        if (!claimed.rows[0]) {
          const existing = await client.query<{
            request_hash: string;
            response_body: Record<string, unknown> | null;
          }>(
            `
              SELECT request_hash, response_body
              FROM idempotency_keys
              WHERE key=$1 AND user_id=$2
            `,
            [idempotencyKey, user.id]
          );
          if (
            existing.rows[0]?.request_hash === requestHash &&
            existing.rows[0].response_body
          ) {
            return existing.rows[0].response_body;
          }
          throw new ConflictException('幂等键已被其他请求使用');
        }

        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          dto.makeupArtistId
        ]);
        const eligible = await client.query(
          `
            SELECT 1
            FROM people artist
            JOIN person_roles artist_role ON artist_role.person_id=artist.id
              AND artist_role.role='MAKEUP_ARTIST' AND artist_role.enabled
            JOIN staff_daily_schedules schedule ON schedule.person_id=artist.id
              AND schedule.role='MAKEUP_ARTIST'
              AND schedule.source_type='FEISHU'
              AND schedule.is_bookable
              AND NOT schedule.is_rest
              AND NOT schedule.is_leave
              AND schedule.parse_status='SUCCESS'
              AND schedule.cancelled_at IS NULL
              AND schedule.starts_at <= $2
              AND schedule.ends_at >= $3
              AND (
                NOT EXISTS (
                  SELECT 1 FROM staff_schedule_segments configured
                  WHERE configured.schedule_id=schedule.id
                )
                OR EXISTS (
                  SELECT 1 FROM staff_schedule_segments segment
                  WHERE segment.schedule_id=schedule.id
                    AND segment.bookable
                    AND segment.starts_at <= $2
                    AND segment.ends_at >= $3
                )
              )
            WHERE artist.id=$1
              AND artist.archived_at IS NULL
              AND artist.booking_allowed
              AND artist.login_allowed
              AND EXISTS (
                SELECT 1 FROM users artist_user
                WHERE artist_user.person_id=artist.id
                  AND artist_user.disabled_at IS NULL
                  AND (
                    artist_user.password_hash IS NOT NULL
                    OR artist_user.feishu_open_id IS NOT NULL
                  )
              )
              AND EXISTS (
                SELECT 1 FROM people requester
                JOIN person_roles requester_role
                  ON requester_role.person_id=requester.id
                  AND requester_role.role::text=$5
                  AND requester_role.enabled
                WHERE requester.id=$4
                  AND requester.archived_at IS NULL
                  AND requester.login_allowed
                  AND requester.booking_allowed
              )
              AND NOT EXISTS (
                SELECT 1 FROM makeup_artist_availability unavailable
                WHERE unavailable.makeup_artist_id=artist.id
                  AND NOT unavailable.bookable
                  AND unavailable.starts_at < $3
                  AND unavailable.ends_at > $2
              )
              AND NOT EXISTS (
                SELECT 1 FROM person_temporary_statuses temporary
                WHERE temporary.person_id=artist.id
                  AND temporary.cancelled_at IS NULL
                  AND temporary.status_type IN (
                    'BREAK','LEAVE','UNAVAILABLE','TRAINING'
                  )
                  AND temporary.starts_at < $3
                  AND temporary.ends_at > $2
              )
              AND NOT EXISTS (
                SELECT 1 FROM makeup_appointments conflict
                WHERE conflict.makeup_artist_id=artist.id
                  AND conflict.source_type<>'FEISHU'
                  AND conflict.status IN (
                    'BOOKED','IN_PROGRESS','RESCHEDULE_REQUIRED',
                    'REASSIGN_REQUIRED','EXCEPTION'
                  )
                  AND conflict.planned_start_at < $3
                  AND conflict.planned_end_at > $2
              )
          `,
          [
            dto.makeupArtistId,
            start.toISOString(),
            end.toISOString(),
            user.personId,
            subjectType
          ]
        );
        if (!eligible.rows[0]) {
          throw new ConflictException(
            '该时间已不可预约，请刷新后选择新的预计时间'
          );
        }

        const id = randomUUID();
        const appointmentNo = this.appointmentNo(id);
        const result = await client.query<AppointmentDbRow>(
          `
            INSERT INTO makeup_appointments(
              id, appointment_no, makeup_date,
              subject_type, subject_person_id,
              anchor_id, live_session_id, room_id,
              requester_id, requester_role, makeup_artist_id,
              service_type_id, planned_start_at, planned_end_at,
              planned_minutes, location, original_requirement, source_type
            )
            VALUES (
              $1,$2,($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
              $4::varchar,$5,NULL,NULL,NULL,$5,$12::person_role,
              $6,$7,$3,$8,$9,$10,$11,'APPLICATION'
            )
            RETURNING *
          `,
          [
            id,
            appointmentNo,
            start.toISOString(),
            subjectType,
            user.personId,
            dto.makeupArtistId,
            service.id,
            end.toISOString(),
            service.default_minutes,
            dto.location?.trim() || '妆造间',
            dto.note?.trim() || null,
            subjectType
          ]
        );
        const created = result.rows[0];
        if (!created) throw new Error('预约写入后未返回记录');
        await client.query(
          `
            INSERT INTO appointment_status_logs(
              appointment_id, to_status, actor_id, action, details
            ) VALUES ($1,'BOOKED',$2,'REQUESTER_BOOK',$3)
          `,
          [
            id,
            user.personId,
            JSON.stringify({
              subjectType,
              estimatedStartAt: start.toISOString(),
              estimatedEndAt: end.toISOString()
            })
          ]
        );
        await this.enqueueNotifications(
          client,
          created,
          'APPOINTMENT_BOOKED',
          user.personId
        );
        await client.query(
          `
            UPDATE idempotency_keys
            SET response_status=201, response_body=$2
            WHERE key=$1
          `,
          [idempotencyKey, JSON.stringify(created)]
        );
        return created;
      });
      this.publishAppointment('appointment.booked', appointment);
      return appointment;
    } catch (error) {
      this.translateConstraintError(error);
    } finally {
      await lock.release();
    }
  }

  async quickBook(
    user: CurrentUser,
    dto: QuickBookDto,
    idempotencyKey: string
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new UnprocessableEntityException('一键预约必须提供有效 Idempotency-Key');
    }
    const recommendation = await this.recommendation(
      user,
      dto.liveSessionId,
      dto.serviceTypeCode
    );
    const selected = dto.makeupArtistId
      ? recommendation.recommendations.find(
          (item) => item.makeupArtistId === dto.makeupArtistId
        )
      : recommendation.recommendations[0];
    if (!selected) throw new ConflictException('当前没有满足规则的可用化妆师');

    const lock = await this.locks.acquire(
      `booking:${selected.makeupArtistId}:${selected.startsAt}`
    );
    if (!lock) throw new ConflictException('该时间正在被其他主播预约，请重试');
    try {
      const appointment = await this.db.transaction((client) =>
        this.createInsideTransaction(
          client,
          user,
          dto,
          selected,
          recommendation.liveSession,
          idempotencyKey
        )
      );
      this.publishAppointment('appointment.booked', appointment);
      return appointment;
    } finally {
      await lock.release();
    }
  }

  async manualTask(
    user: CurrentUser,
    dto: ManualTaskDto,
    idempotencyKey: string
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new UnprocessableEntityException(
        '补录临时任务必须提供有效 Idempotency-Key'
      );
    }
    const start = new Date(dto.plannedStartAt);
    const end = new Date(dto.plannedEndAt);
    if (start <= new Date() || end <= start) {
      throw new UnprocessableEntityException('临时任务时间必须有效且晚于当前时间');
    }

    const lock = await this.locks.acquire(
      `booking:${user.personId}:${start.toISOString()}`
    );
    if (!lock) {
      throw new ConflictException('该时间正在被其他预约请求占用，请重试');
    }
    try {
      const appointment = await this.db.transaction(async (client) => {
        const requestHash = createHash('sha256')
          .update(JSON.stringify(dto))
          .digest('hex');
        const claimed = await client.query(
          `
            INSERT INTO idempotency_keys(
              key, user_id, operation, request_hash, expires_at
            )
            VALUES ($1,$2,'MANUAL_TASK',$3,now()+interval '24 hours')
            ON CONFLICT (key) DO NOTHING
            RETURNING key
          `,
          [idempotencyKey, user.id, requestHash]
        );
        if (!claimed.rows[0]) {
          const existing = await client.query<{
            request_hash: string;
            response_body: Record<string, unknown> | null;
          }>(
            `SELECT request_hash, response_body
             FROM idempotency_keys WHERE key=$1 AND user_id=$2`,
            [idempotencyKey, user.id]
          );
          if (
            existing.rows[0]?.request_hash === requestHash &&
            existing.rows[0].response_body
          ) {
            return existing.rows[0].response_body;
          }
          throw new ConflictException('幂等键已被其他请求使用');
        }

        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          user.personId
        ]);
        const serviceCode = dto.serviceTypeCode ?? 'FULL_LIVE_LOOK';
        const context = await client.query<{
          anchor_id: string;
          room_id: string;
          room_name: string;
          service_type_id: string;
          buffer_after_minutes: number;
        }>(
          `
            SELECT ls.anchor_id, ls.room_id, r.name AS room_name,
                   st.id AS service_type_id, st.buffer_after_minutes
            FROM live_sessions ls
            JOIN rooms r ON r.id=ls.room_id
            JOIN makeup_service_types st ON st.code=$5 AND st.enabled
            WHERE ls.id=$1 AND ls.status='SCHEDULED'
              AND ls.source_type='FEISHU'
              AND $3::timestamptz <= ls.starts_at
                - (st.buffer_after_minutes * interval '1 minute')
              AND EXISTS (
                SELECT 1
                FROM people p
                JOIN person_roles pr ON pr.person_id=p.id
                  AND pr.role='MAKEUP_ARTIST' AND pr.enabled
                JOIN staff_daily_schedules s ON s.person_id=p.id
                  AND s.role='MAKEUP_ARTIST' AND s.is_bookable
                  AND s.source_type='FEISHU'
                  AND s.parse_status='SUCCESS'
                  AND s.starts_at <= $2 AND s.ends_at >= $3
                  AND (
                    NOT EXISTS (
                      SELECT 1 FROM staff_schedule_segments configured
                      WHERE configured.schedule_id=s.id
                    )
                    OR EXISTS (
                      SELECT 1 FROM staff_schedule_segments segment
                      WHERE segment.schedule_id=s.id AND segment.bookable
                        AND segment.starts_at <= $2 AND segment.ends_at >= $3
                    )
                  )
                WHERE p.id=$4 AND p.booking_allowed
                  AND p.archived_at IS NULL
                  AND p.login_allowed
                  AND EXISTS (
                    SELECT 1 FROM users artist_user
                    WHERE artist_user.person_id=p.id
                      AND artist_user.disabled_at IS NULL
                      AND (
                        artist_user.password_hash IS NOT NULL
                        OR artist_user.feishu_open_id IS NOT NULL
                      )
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM makeup_artist_availability av
                    WHERE av.makeup_artist_id=p.id AND NOT av.bookable
                      AND av.starts_at < $3 AND av.ends_at > $2
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM person_temporary_statuses temporary
                    WHERE temporary.person_id=p.id
                      AND temporary.cancelled_at IS NULL
                      AND temporary.status_type IN (
                        'BREAK','LEAVE','UNAVAILABLE','TRAINING'
                      )
                      AND temporary.starts_at < $3 AND temporary.ends_at > $2
                  )
              )
          `,
          [
            dto.liveSessionId,
            start.toISOString(),
            end.toISOString(),
            user.personId,
            serviceCode
          ]
        );
        const taskContext = context.rows[0];
        if (!taskContext) {
          throw new ConflictException(
            '直播班次无效、化妆师不在可预约班次内，或无法在开播安全时间前完成'
          );
        }

        const id = randomUUID();
        const appointmentNo = `MUA-${new Date()
          .toISOString()
          .slice(0, 10)
          .replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`;
        const result = await client.query<AppointmentDbRow>(
          `
            INSERT INTO makeup_appointments(
              id, appointment_no, makeup_date,
              subject_type, subject_person_id,
              anchor_id, live_session_id, room_id,
              requester_id, requester_role, makeup_artist_id,
              service_type_id, planned_start_at, planned_end_at,
              planned_minutes, location, source_type
            )
            VALUES (
              $1,$2,($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
              'ANCHOR',$4,$4,$5,$6,$7,'MAKEUP_ARTIST',$7,$8,$3,$9,$10,$11,
              'APPLICATION'
            )
            RETURNING *
          `,
          [
            id,
            appointmentNo,
            start.toISOString(),
            taskContext.anchor_id,
            dto.liveSessionId,
            taskContext.room_id,
            user.personId,
            taskContext.service_type_id,
            end.toISOString(),
            Math.ceil((end.getTime() - start.getTime()) / 60_000),
            taskContext.room_name
          ]
        );
        const appointment = result.rows[0];
        if (!appointment) throw new Error('临时任务写入后未返回记录');
        await client.query(
          `
            INSERT INTO appointment_status_logs(
              appointment_id, to_status, actor_id, action, details
            ) VALUES ($1,'BOOKED',$2,'MANUAL_TASK',$3)
          `,
          [id, user.personId, JSON.stringify(dto)]
        );
        await this.enqueueNotifications(
          client,
          appointment,
          'APPOINTMENT_BOOKED',
          user.personId
        );
        await client.query(
          `
            UPDATE idempotency_keys
            SET response_status=201, response_body=$2
            WHERE key=$1
          `,
          [idempotencyKey, JSON.stringify(appointment)]
        );
        return appointment;
      });
      this.publishAppointment('appointment.booked', appointment);
      return appointment;
    } catch (error) {
      this.translateConstraintError(error);
    } finally {
      await lock.release();
    }
  }

  async start(
    user: CurrentUser,
    appointmentId: string
  ): Promise<AppointmentDbRow> {
    return this.transition(
      user,
      appointmentId,
      ['BOOKED', 'EXCEPTION'],
      'IN_PROGRESS',
      'START',
      'actual_start_at=now()'
    );
  }

  async complete(
    user: CurrentUser,
    appointmentId: string
  ): Promise<AppointmentDbRow> {
    return this.transition(
      user,
      appointmentId,
      ['IN_PROGRESS', 'EXCEPTION'],
      'COMPLETED',
      'COMPLETE',
      'actual_end_at=now()'
    );
  }

  async exception(
    user: CurrentUser,
    appointmentId: string,
    dto: AppointmentExceptionDto
  ) {
    this.stateMachine.assertTransition('IN_PROGRESS', 'EXCEPTION');
    const appointment = await this.db.transaction(async (client) => {
      const result = await client.query<AppointmentDbRow>(
        `
          UPDATE makeup_appointments
          SET status='EXCEPTION', exception_type=$3, exception_note=$4,
              data_version=data_version+1
          WHERE id=$1 AND makeup_artist_id=$2
            AND status='IN_PROGRESS'
          RETURNING *
        `,
        [appointmentId, user.personId, dto.exceptionType, dto.note ?? null]
      );
      const appointment = result.rows[0];
      if (!appointment) throw new ForbiddenException('只能反馈自己的有效任务');
      await client.query(
        `
          INSERT INTO appointment_exceptions(
            appointment_id, exception_type, note, reported_by, metadata
          ) VALUES ($1,$2,$3,$4,$5)
        `,
        [
          appointmentId,
          dto.exceptionType,
          dto.note ?? null,
          user.personId,
          JSON.stringify(dto)
        ]
      );
      await client.query(
        `
          INSERT INTO appointment_status_logs(
            appointment_id, from_status, to_status, actor_id, action, details
          )
          VALUES ($1,'IN_PROGRESS','EXCEPTION',$2,'EXCEPTION',$3)
        `,
        [appointmentId, user.personId, JSON.stringify(dto)]
      );
      await this.enqueueNotifications(
        client,
        appointment,
        'APPOINTMENT_EXCEPTION',
        user.personId
      );
      return appointment;
    });
    this.publishAppointment('appointment.exception', appointment);
    return appointment;
  }

  async cancel(user: CurrentUser, appointmentId: string) {
    const appointment = await this.db.transaction(async (client) => {
      const current = await client.query<AppointmentDbRow & {
        requester_id: string;
      }>(
        `
          SELECT * FROM makeup_appointments WHERE id=$1 FOR UPDATE
        `,
        [appointmentId]
      );
      const existing = current.rows[0];
      if (!existing) {
        throw new NotFoundException('预约不存在');
      }
      this.assertAppointmentAccess(user, existing);
      this.stateMachine.assertTransition(existing.status, 'CANCELLED');
      const result = await client.query<AppointmentDbRow>(
        `
          UPDATE makeup_appointments
          SET status='CANCELLED', data_version=data_version+1
          WHERE id=$1 AND status=$2
          RETURNING *
        `,
        [appointmentId, existing.status]
      );
      const appointment = result.rows[0];
      if (!appointment) throw new ConflictException('预约状态已发生变化，请刷新');
      await client.query(
        `
          INSERT INTO appointment_status_logs(
            appointment_id, from_status, to_status, actor_id, action
          ) VALUES ($1,$2,'CANCELLED',$3,'CANCEL')
        `,
        [appointmentId, existing.status, user.personId]
      );
      await this.enqueueNotifications(
        client,
        appointment,
        'APPOINTMENT_CANCELLED',
        user.personId
      );
      return appointment;
    });
    this.publishAppointment('appointment.cancelled', appointment);
    return appointment;
  }

  async reschedule(
    user: CurrentUser,
    appointmentId: string,
    dto: RescheduleAppointmentDto
  ) {
    try {
      const appointment = await this.db.transaction(async (client) => {
        const current = await client.query<{
          planned_minutes: number;
          makeup_artist_id: string;
          requester_id: string;
          subject_person_id: string;
          room_id: string | null;
          status: AppointmentStatus;
          live_session_id: string | null;
          buffer_after_minutes: number;
        }>(
          `
            SELECT a.*, st.buffer_after_minutes
            FROM makeup_appointments a
            JOIN makeup_service_types st ON st.id=a.service_type_id
            WHERE a.id=$1
            FOR UPDATE
          `,
          [appointmentId]
        );
        const row = current.rows[0];
        if (!row) {
          throw new NotFoundException('预约不存在');
        }
        this.assertAppointmentAccess(user, row);
        if (row.status !== 'BOOKED') {
          throw new ConflictException('只能调整尚未开始的预约');
        }

        const artistId = dto.makeupArtistId ?? row.makeup_artist_id;
        const start = new Date(dto.plannedStartAt);
        const end = new Date(start.getTime() + row.planned_minutes * 60_000);
        if (start <= new Date()) {
          throw new ConflictException('改期时间必须晚于当前时间');
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          artistId
        ]);
        const eligible = await client.query(
          `
            SELECT 1
            FROM people p
            JOIN person_roles pr ON pr.person_id=p.id
              AND pr.role='MAKEUP_ARTIST' AND pr.enabled
            JOIN staff_daily_schedules s ON s.person_id=p.id
              AND s.role='MAKEUP_ARTIST' AND s.is_bookable
              AND s.source_type='FEISHU'
              AND s.parse_status='SUCCESS'
              AND s.starts_at <= $2 AND s.ends_at >= $3
              AND (
                NOT EXISTS (
                  SELECT 1 FROM staff_schedule_segments configured
                  WHERE configured.schedule_id=s.id
                )
                OR EXISTS (
                  SELECT 1 FROM staff_schedule_segments segment
                  WHERE segment.schedule_id=s.id AND segment.bookable
                    AND segment.starts_at <= $2 AND segment.ends_at >= $3
                )
              )
            LEFT JOIN live_sessions ls ON ls.id=$4
              AND ls.source_type='FEISHU'
            WHERE p.id=$1 AND p.booking_allowed
              AND p.archived_at IS NULL
              AND p.login_allowed
              AND EXISTS (
                SELECT 1 FROM users artist_user
                WHERE artist_user.person_id=p.id
                  AND artist_user.disabled_at IS NULL
                  AND (
                    artist_user.password_hash IS NOT NULL
                    OR artist_user.feishu_open_id IS NOT NULL
                  )
              )
              AND (
                $4::uuid IS NULL
                OR (
                  ls.id IS NOT NULL
                  AND ls.status='SCHEDULED'
                  AND $3 <= ls.starts_at
                    - ($5::int * interval '1 minute')
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM makeup_artist_availability av
                WHERE av.makeup_artist_id=p.id AND NOT av.bookable
                  AND av.starts_at < $3 AND av.ends_at > $2
              )
              AND NOT EXISTS (
                SELECT 1 FROM person_temporary_statuses temporary
                WHERE temporary.person_id=p.id
                  AND temporary.cancelled_at IS NULL
                  AND temporary.status_type IN (
                    'BREAK','LEAVE','UNAVAILABLE','TRAINING'
                  )
                  AND temporary.starts_at < $3 AND temporary.ends_at > $2
              )
          `,
          [
            artistId,
            start.toISOString(),
            end.toISOString(),
            row.live_session_id,
            row.buffer_after_minutes
          ]
        );
        if (!eligible.rows[0]) {
          throw new ConflictException(
            '新时间不在有效班次内，或无法在开播安全时间前完成'
          );
        }

        const result = await client.query<AppointmentDbRow>(
          `
            UPDATE makeup_appointments
            SET makeup_artist_id=$2, planned_start_at=$3, planned_end_at=$4,
                makeup_date=($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
                status='BOOKED', data_version=data_version+1
            WHERE id=$1
            RETURNING *
          `,
          [
            appointmentId,
            artistId,
            start.toISOString(),
            end.toISOString()
          ]
        );
        const appointment = result.rows[0];
        if (!appointment) throw new Error('改期后未返回预约记录');
        await client.query(
          `
            INSERT INTO appointment_status_logs(
              appointment_id, from_status, to_status, actor_id, action, details
            ) VALUES ($1,'BOOKED','BOOKED',$2,'RESCHEDULE',$3)
          `,
          [appointmentId, user.personId, JSON.stringify(dto)]
        );
        await this.enqueueNotifications(
          client,
          appointment,
          'APPOINTMENT_RESCHEDULED',
          user.personId
        );
        return appointment;
      });
      this.publishAppointment('appointment.rescheduled', appointment);
      return appointment;
    } catch (error) {
      this.translateConstraintError(error);
    }
  }

  private async createInsideTransaction(
    client: PoolClient,
    user: CurrentUser,
    dto: QuickBookDto,
    selected: MakeupRecommendation,
    session: SessionRow,
    idempotencyKey: string
  ) {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(dto))
      .digest('hex');
    const claimed = await client.query(
      `
        INSERT INTO idempotency_keys(
          key, user_id, operation, request_hash, expires_at
        )
        VALUES ($1,$2,'QUICK_BOOK',$3,now()+interval '24 hours')
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `,
      [idempotencyKey, user.id, requestHash]
    );
    if (!claimed.rows[0]) {
      const existing = await client.query<{
        request_hash: string;
        response_body: Record<string, unknown> | null;
      }>(
        'SELECT request_hash, response_body FROM idempotency_keys WHERE key=$1 AND user_id=$2',
        [idempotencyKey, user.id]
      );
      if (
        existing.rows[0]?.request_hash === requestHash &&
        existing.rows[0].response_body
      ) {
        return existing.rows[0].response_body;
      }
      throw new ConflictException('幂等键已被其他请求使用');
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      selected.makeupArtistId
    ]);
    const lockedSession = await client.query<SessionRow>(
      `
        SELECT ls.*, r.name AS room_name, p.display_name AS anchor_name,
               EXISTS (
                 SELECT 1 FROM live_sessions other
                 WHERE other.id<>ls.id
                   AND other.anchor_id=ls.anchor_id
                   AND other.source_type='FEISHU'
                   AND other.status='SCHEDULED'
                   AND other.cancelled_at IS NULL
                   AND other.starts_at<ls.ends_at
                   AND other.ends_at>ls.starts_at
               ) AS has_schedule_conflict
        FROM live_sessions ls
        JOIN rooms r ON r.id=ls.room_id
        JOIN people p ON p.id=ls.anchor_id
        WHERE ls.id=$1
          AND ls.source_type='FEISHU'
        FOR SHARE
      `,
      [session.id]
    );
    if (
      !lockedSession.rows[0] ||
      lockedSession.rows[0].status !== 'SCHEDULED' ||
      lockedSession.rows[0].starts_at <= new Date()
    ) {
      throw new ConflictException('直播班次已取消、变更或开始');
    }
    const start = new Date(selected.startsAt);
    const end = new Date(selected.endsAt);
    const eligible = await client.query(
      `
        SELECT 1
        FROM people p
        JOIN person_roles pr ON pr.person_id=p.id
          AND pr.role='MAKEUP_ARTIST' AND pr.enabled
        JOIN staff_daily_schedules s ON s.person_id=p.id
          AND s.role='MAKEUP_ARTIST' AND s.is_bookable
          AND s.source_type='FEISHU'
          AND s.parse_status='SUCCESS' AND s.starts_at <= $2 AND s.ends_at >= $3
          AND (
            NOT EXISTS (
              SELECT 1 FROM staff_schedule_segments configured
              WHERE configured.schedule_id=s.id
            )
            OR EXISTS (
              SELECT 1 FROM staff_schedule_segments segment
              WHERE segment.schedule_id=s.id AND segment.bookable
                AND segment.starts_at <= $2 AND segment.ends_at >= $3
            )
          )
        WHERE p.id=$1 AND p.booking_allowed AND p.archived_at IS NULL
          AND p.login_allowed
          AND EXISTS (
            SELECT 1 FROM users artist_user
            WHERE artist_user.person_id=p.id
              AND artist_user.disabled_at IS NULL
              AND (
                artist_user.password_hash IS NOT NULL
                OR artist_user.feishu_open_id IS NOT NULL
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM makeup_artist_availability av
            WHERE av.makeup_artist_id=p.id AND NOT av.bookable
              AND av.starts_at < $3 AND av.ends_at > $2
          )
          AND NOT EXISTS (
            SELECT 1 FROM person_temporary_statuses temporary
            WHERE temporary.person_id=p.id
              AND temporary.cancelled_at IS NULL
              AND temporary.status_type IN (
                'BREAK','LEAVE','UNAVAILABLE','TRAINING'
              )
              AND temporary.starts_at < $3 AND temporary.ends_at > $2
          )
      `,
      [selected.makeupArtistId, start.toISOString(), end.toISOString()]
    );
    if (!eligible.rows[0]) throw new ConflictException('化妆师班次或状态已变化');

    const service = await this.getServiceType(
      dto.serviceTypeCode ?? 'FULL_LIVE_LOOK',
      client
    );
    const id = randomUUID();
    const appointmentNo = `MUA-${new Date()
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`;
    try {
      const result = await client.query<AppointmentDbRow>(
        `
          INSERT INTO makeup_appointments(
            id, appointment_no, makeup_date,
            subject_type, subject_person_id,
            anchor_id, live_session_id, room_id,
            requester_id, requester_role, makeup_artist_id,
            service_type_id, planned_start_at, planned_end_at, planned_minutes,
            location
          )
          VALUES ($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
            'ANCHOR',$4,$4,$5,$6,$7,$8,$9,$10,$3,$11,$12,$13)
          RETURNING *
        `,
        [
          id,
          appointmentNo,
          start.toISOString(),
          session.anchor_id,
          session.id,
          session.room_id,
          user.personId,
          this.requesterRole(user),
          selected.makeupArtistId,
          service.id,
          end.toISOString(),
          Math.ceil((end.getTime() - start.getTime()) / 60_000),
          session.room_name
        ]
      );
      const appointment = result.rows[0];
      if (!appointment) throw new Error('预约写入后未返回记录');
      await client.query(
        `
          INSERT INTO appointment_status_logs(
            appointment_id, to_status, actor_id, action, details
          ) VALUES ($1,'BOOKED',$2,'QUICK_BOOK',$3)
        `,
        [id, user.personId, JSON.stringify({ recommendation: selected })]
      );
      await this.enqueueNotifications(
        client,
        appointment,
        'APPOINTMENT_BOOKED',
        user.personId
      );
      await client.query(
        `
          UPDATE idempotency_keys
          SET response_status=201, response_body=$2
          WHERE key=$1
        `,
        [idempotencyKey, JSON.stringify(appointment)]
      );
      return appointment;
    } catch (error) {
      this.translateConstraintError(error);
    }
  }

  private async transition(
    user: CurrentUser,
    id: string,
    from: AppointmentStatus | AppointmentStatus[],
    to: AppointmentStatus,
    action: string,
    extraUpdate: string
  ): Promise<AppointmentDbRow> {
    const appointment = await this.db.transaction(async (client) => {
      const current = await client.query<{ status: AppointmentStatus }>(
        `
          SELECT status
          FROM makeup_appointments
          WHERE id=$1 AND makeup_artist_id=$2
          FOR UPDATE
        `,
        [id, user.personId]
      );
      const currentStatus = current.rows[0]?.status;
      const allowedFrom = Array.isArray(from) ? from : [from];
      if (!currentStatus || !allowedFrom.includes(currentStatus)) {
        throw new ConflictException(
          '任务状态已变化，或该任务不属于当前化妆师'
        );
      }
      this.stateMachine.assertTransition(currentStatus, to);
      const result = await client.query<AppointmentDbRow>(
        `
          UPDATE makeup_appointments
          SET status=$3, ${extraUpdate}, data_version=data_version+1
          WHERE id=$1 AND makeup_artist_id=$2
          RETURNING *
        `,
        [id, user.personId, to]
      );
      if (!result.rows[0]) {
        throw new ConflictException('任务状态已变化或不属于当前化妆师');
      }
      await client.query(
        `
          INSERT INTO appointment_status_logs(
            appointment_id, from_status, to_status, actor_id, action
          ) VALUES ($1,$2,$3,$4,$5)
        `,
        [id, currentStatus, to, user.personId, action]
      );
      const appointment = result.rows[0];
      await this.enqueueNotifications(
        client,
        appointment,
        `APPOINTMENT_${to}`,
        user.personId
      );
      return appointment;
    });
    this.publishAppointment(`appointment.${to.toLowerCase()}`, appointment);
    return appointment;
  }

  private async enqueueNotifications(
    client: PoolClient,
    appointment: AppointmentDbRow,
    eventType: string,
    actorId: string
  ): Promise<void> {
    const recipients = [
      appointment.subject_person_id,
      appointment.makeup_artist_id
    ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
    for (const recipient of recipients) {
      const idempotencyKey =
        `${eventType}:${appointment.id}:${recipient}:${appointment.data_version}`;
      await client.query(
        `
          INSERT INTO notification_outbox(
            event_type, aggregate_type, aggregate_id, recipient_person_id,
            idempotency_key, payload
          )
          VALUES ($1,'MAKEUP_APPOINTMENT',$2,$3,$4,$5)
          ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          eventType,
          appointment.id,
          recipient,
          idempotencyKey,
          JSON.stringify(appointment)
        ]
      );
      await client.query(
        `
          INSERT INTO notifications(
            recipient_person_id, event_type, title, body,
            resource_type, resource_id, severity, idempotency_key, metadata
          )
          VALUES (
            $1,$2,$3,$4,'MAKEUP_APPOINTMENT',$5,$6,$7,$8
          )
          ON CONFLICT (idempotency_key)
            WHERE idempotency_key IS NOT NULL
          DO NOTHING
        `,
        [
          recipient,
          eventType,
          this.notificationTitle(eventType),
          this.notificationBody(eventType),
          appointment.id,
          eventType === 'APPOINTMENT_EXCEPTION' ? 'WARNING' : 'INFO',
          idempotencyKey,
          JSON.stringify({ dataVersion: appointment.data_version })
        ]
      );
    }
    await this.scheduleNotifications.enqueueAppointmentBooked(
      client,
      appointment,
      eventType
    );
    await client.query(
      `
        INSERT INTO feishu_write_outbox(
          operation, aggregate_type, aggregate_id, idempotency_key, payload
        )
        VALUES ('UPSERT_APPOINTMENT','MAKEUP_APPOINTMENT',$1,$2,$3)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        appointment.id,
        `UPSERT_APPOINTMENT:${appointment.id}:${appointment.data_version}`,
        JSON.stringify({
          id: appointment.id,
          status: appointment.status,
          data_version: appointment.data_version,
          event_type: eventType
        })
      ]
    );
    await client.query(
      `
        INSERT INTO operation_logs(
          actor_id, action, resource_type, resource_id, after_data
        ) VALUES ($1,$2,'MAKEUP_APPOINTMENT',$3,$4)
      `,
      [actorId, eventType, appointment.id, JSON.stringify(appointment)]
    );
  }

  private async getSession(id: string): Promise<SessionRow> {
    const result = await this.db.query<SessionRow>(
      `
        SELECT ls.*, r.name AS room_name, p.display_name AS anchor_name
        FROM live_sessions ls
        JOIN rooms r ON r.id=ls.room_id
        JOIN people p ON p.id=ls.anchor_id
        WHERE ls.id=$1
          AND ls.source_type='FEISHU'
      `,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('直播班次不存在');
    return result.rows[0];
  }

  private async getServiceType(
    code: string,
    client?: PoolClient
  ): Promise<ServiceTypeRow> {
    const result = client
      ? await client.query<ServiceTypeRow>(
          'SELECT * FROM makeup_service_types WHERE code=$1 AND enabled',
          [code]
        )
      : await this.db.query<ServiceTypeRow>(
          'SELECT * FROM makeup_service_types WHERE code=$1 AND enabled',
          [code]
        );
    if (!result.rows[0]) throw new NotFoundException('妆造类型不存在或已停用');
    return result.rows[0];
  }

  private async integerSetting(key: string, fallback: number): Promise<number> {
    const result = await this.db.query<{ value: string | null }>(
      `SELECT value #>> '{}' AS value FROM system_settings WHERE key=$1`,
      [key]
    );
    const parsed = Number(result.rows[0]?.value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private assertGeneralRequesterService(service: ServiceTypeRow): void {
    if (!isGeneralRequesterDurationAllowed(service.default_minutes)) {
      throw new UnprocessableEntityException(
        '达人和编导只能预约预计30至40分钟的普通妆造服务'
      );
    }
  }

  private currentAvailabilityBlock(
    blocks: AvailabilityBlockRow[],
    now: Date
  ): AvailabilityBlockRow | undefined {
    const priority = (blockType: string) => {
      if (blockType === 'APPOINTMENT:IN_PROGRESS') return 0;
      if (blockType.startsWith('APPOINTMENT:')) return 1;
      if (blockType === 'LEAVE') return 2;
      if (blockType === 'BREAK') return 3;
      return 4;
    };
    return blocks
      .filter((block) => block.starts_at <= now && block.ends_at > now)
      .sort((left, right) => priority(left.block_type) - priority(right.block_type))[0];
  }

  private assertSessionAccess(user: CurrentUser, session: SessionRow): void {
    const canManageAll = user.roles.some((role) =>
      ['ADMIN', 'DEVELOPER', 'LIVE_SUPERVISOR'].includes(role)
    );
    if (
      user.roles.includes('ANCHOR') &&
      !canManageAll &&
      !user.roles.includes('FIELD_CONTROL') &&
      session.anchor_id !== user.personId
    ) {
      throw new ForbiddenException('主播只能为自己的直播班次预约');
    }
    if (
      user.roles.includes('FIELD_CONTROL') &&
      !canManageAll &&
      !user.roomIds.includes(session.room_id)
    ) {
      throw new ForbiddenException('场控只能操作负责直播间');
    }
  }

  private requesterRole(user: CurrentUser) {
    return (
      user.roles.find((role) =>
        [
          'ANCHOR',
          'TALENT',
          'DIRECTOR',
          'FIELD_CONTROL',
          'LIVE_SUPERVISOR',
          'ADMIN'
        ].includes(role)
      ) ?? 'ANCHOR'
    );
  }

  private requesterSubjectRole(user: CurrentUser): Extract<
    PersonRole,
    'TALENT' | 'DIRECTOR'
  > {
    if (user.roles.includes('TALENT')) return 'TALENT';
    if (user.roles.includes('DIRECTOR')) return 'DIRECTOR';
    throw new ForbiddenException('只有达人或编导账号可以使用此预约入口');
  }

  private assertAppointmentAccess(
    user: CurrentUser,
    appointment: {
      requester_id: string;
      subject_person_id?: string;
      room_id: string | null;
    }
  ): void {
    if (
      appointment.requester_id === user.personId ||
      appointment.subject_person_id === user.personId ||
      user.roles.some((role) =>
        ['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER'].includes(role)
      ) ||
      (user.roles.includes('FIELD_CONTROL') &&
        Boolean(appointment.room_id) &&
        user.roomIds.includes(appointment.room_id!))
    ) {
      return;
    }
    throw new ForbiddenException('只能操作本人或授权直播间内的预约');
  }

  private publishAppointment(
    type: string,
    appointment: Record<string, unknown>
  ): void {
    const subjectId = this.primitiveString(
      appointment.subject_person_id ?? appointment.anchor_id
    );
    const artistId = this.primitiveString(appointment.makeup_artist_id);
    const roomId = this.primitiveString(appointment.room_id);
    this.realtime.publish(
      type,
      {
        appointmentId: this.primitiveString(appointment.id),
        status: this.primitiveString(appointment.status),
        dataVersion: Number(appointment.data_version ?? 0)
      },
      [subjectId, artistId].filter(Boolean),
      roomId ? [roomId] : []
    );
  }

  private dayBounds(date: string): { start: Date; end: Date } {
    const start = new Date(`${date}T00:00:00+08:00`);
    if (!Number.isFinite(start.getTime())) {
      throw new UnprocessableEntityException('预约日期格式不正确');
    }
    return {
      start,
      end: new Date(start.getTime() + 24 * 60 * 60_000)
    };
  }

  private buildAvailabilitySlots(
    windows: AvailabilityWindowRow[],
    blocks: AvailabilityBlockRow[],
    durationMinutes: number,
    now: Date
  ): Array<{ startsAt: string; endsAt: string; estimated: true }> {
    const result: Array<{
      startsAt: string;
      endsAt: string;
      estimated: true;
    }> = [];
    const stepMs = 30 * 60_000;
    const durationMs = durationMinutes * 60_000;
    for (const window of [...windows].sort(
      (left, right) => left.starts_at.getTime() - right.starts_at.getTime()
    )) {
      const earliest = Math.max(window.starts_at.getTime(), now.getTime());
      let cursor = new Date(Math.ceil(earliest / stepMs) * stepMs);
      while (cursor.getTime() + durationMs <= window.ends_at.getTime()) {
        const end = new Date(cursor.getTime() + durationMs);
        const overlaps = blocks.some(
          (block) => block.starts_at < end && block.ends_at > cursor
        );
        if (!overlaps) {
          result.push({
            startsAt: cursor.toISOString(),
            endsAt: end.toISOString(),
            estimated: true
          });
          if (result.length >= 8) return result;
        }
        cursor = new Date(cursor.getTime() + stepMs);
      }
    }
    return result;
  }

  private publicRequesterStatus(
    blockType: string | undefined,
    onDuty: boolean,
    nextAvailableAt: string | undefined,
    now: Date
  ): RequesterMakeupArtistAvailability['publicStatus'] {
    if (blockType === 'APPOINTMENT:IN_PROGRESS') return 'IN_PROGRESS';
    if (blockType?.startsWith('APPOINTMENT:')) return 'BOOKED';
    if (blockType === 'LEAVE') return 'LEAVE';
    if (blockType === 'BREAK') return 'BREAK';
    if (blockType === 'UNAVAILABLE' || blockType === 'TRAINING') {
      return 'UNAVAILABLE';
    }
    if (blockType === 'AVAILABILITY') return 'UNAVAILABLE';
    if (onDuty) return 'AVAILABLE';
    if (
      nextAvailableAt &&
      new Date(nextAvailableAt).getTime() <= now.getTime() + 60 * 60_000
    ) {
      return 'BUSY_SOON';
    }
    return 'OFF_DUTY';
  }

  private appointmentNo(id: string): string {
    return `MUA-${new Date()
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`;
  }

  private primitiveString(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';
  }

  private notificationTitle(eventType: string): string {
    const titles: Record<string, string> = {
      APPOINTMENT_BOOKED: '妆造预约已确认',
      APPOINTMENT_IN_PROGRESS: '妆造已开始',
      APPOINTMENT_COMPLETED: '妆造已完成',
      APPOINTMENT_CANCELLED: '妆造预约已取消',
      APPOINTMENT_RESCHEDULED: '妆造预约时间已调整',
      APPOINTMENT_EXCEPTION: '妆造任务出现异常'
    };
    return titles[eventType] ?? '妆造任务状态已更新';
  }

  private notificationBody(eventType: string): string {
    const bodies: Record<string, string> = {
      APPOINTMENT_BOOKED: '预约时间和化妆师已经锁定，请按计划到达妆造地点。',
      APPOINTMENT_IN_PROGRESS: '化妆师已经开始服务，相关直播间状态已同步更新。',
      APPOINTMENT_COMPLETED: '本次妆造已经完成，请按直播排班做好开播准备。',
      APPOINTMENT_CANCELLED: '本次妆造预约已取消，原占用时间已经释放。',
      APPOINTMENT_RESCHEDULED: '预约时间或化妆师已经调整，请查看最新安排。',
      APPOINTMENT_EXCEPTION: '任务已进入异常处理，请关注场控或主管的处理结果。'
    };
    return bodies[eventType] ?? '请打开系统查看最新任务详情。';
  }

  private translateConstraintError(error: unknown): never {
    if (error instanceof DatabaseError) {
      if (error.code === '23P01') {
        throw new ConflictException('该化妆师在所选时间已有有效预约');
      }
      if (error.code === '23505') {
        throw new ConflictException('该直播班次已经存在有效妆造预约');
      }
    }
    throw error;
  }
}
