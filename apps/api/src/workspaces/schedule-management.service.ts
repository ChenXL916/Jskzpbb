import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { CurrentUser } from '@jishi/contracts';
import { randomUUID } from 'node:crypto';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  SaveLiveSessionDto,
  SaveStaffShiftDto
} from './schedule-management.dto';

interface LiveSessionRow extends QueryResultRow {
  id: string;
  room_id: string;
  anchor_id: string;
  starts_at: Date;
  ends_at: Date;
  schedule_type: string;
  makeup_required: boolean;
  status: string;
  notes: string | null;
  version: number;
  source_type: string;
}

interface StaffShiftRow extends QueryResultRow {
  id: string;
  person_id: string;
  schedule_date: string;
  role: string;
  raw_shift_value: string;
  starts_at: Date | null;
  ends_at: Date | null;
  is_rest: boolean;
  is_leave: boolean;
  is_bookable: boolean;
  notes: string | null;
  version: number;
  source_type: string;
}

interface ShiftTemplateRow extends QueryResultRow {
  id: string;
  name: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  crosses_midnight: boolean;
  bookable: boolean;
  confirmation_required: boolean;
  segments: unknown;
}

interface AppointmentImpactRow extends QueryResultRow {
  id: string;
  status: string;
  anchor_id: string;
  makeup_artist_id: string;
  requester_id: string;
  data_version: number;
  planned_end_at: Date;
}

interface ShiftResolution {
  rawShiftValue: string;
  startsAt: Date | null;
  endsAt: Date | null;
  isBookable: boolean;
  parseStatus: 'SUCCESS';
  segments: Array<{ startsAt: Date; endsAt: Date; bookable: boolean }>;
}

@Injectable()
export class ScheduleManagementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService
  ) {}

  async options() {
    const [people, rooms, templates, authority] = await Promise.all([
      this.db.query(
        `
          SELECT p.id, p.display_name, p.employment_status,
                 array_agg(pr.role::text ORDER BY pr.role::text) AS roles
          FROM people p
          JOIN person_roles pr ON pr.person_id=p.id AND pr.enabled
          WHERE p.archived_at IS NULL
            AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
            AND pr.role IN ('ANCHOR','MAKEUP_ARTIST','FIELD_CONTROL')
          GROUP BY p.id
          ORDER BY p.display_name
        `
      ),
      this.db.query(
        `SELECT id, name, location FROM rooms WHERE enabled ORDER BY name`
      ),
      this.db.query(
        `
          SELECT id, name, start_time, end_time, duration_minutes,
                 crosses_midnight, bookable, confirmation_required, segments
          FROM shift_templates
          WHERE enabled
          ORDER BY name
        `
      ),
      this.db.query<{ value: string }>(
        `SELECT value #>> '{}' AS value FROM system_settings WHERE key='schedule.data_authority'`
      )
    ]);
    const dataAuthority =
      authority.rows[0]?.value ?? 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS';
    return {
      people: people.rows,
      rooms: rooms.rows,
      shiftTemplates: templates.rows,
      dataAuthority,
      scheduleEditable: dataAuthority !== 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS',
      syncSupported: dataAuthority === 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS'
    };
  }

  async createLiveSession(user: CurrentUser, dto: SaveLiveSessionDto) {
    const id = randomUUID();
    const result = await this.db.transaction(async (client) => {
      await this.lockResources(client, [
        `anchor:${dto.anchorId}`,
        `room:${dto.roomId}`,
        ...(dto.fieldControlId ? [`field-control:${dto.fieldControlId}`] : [])
      ]);
      await this.assertLiveResources(client, dto);
      await this.assertLiveConflicts(client, dto);
      const created = (
        await client.query<LiveSessionRow>(
          `
            INSERT INTO live_sessions(
              id, room_id, anchor_id, starts_at, ends_at, schedule_type,
              makeup_required, status, source_fingerprint, source_type,
              notes, created_by, updated_by
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,'SCHEDULED',$8,'LOCAL',$9,$10,$10
            )
            RETURNING *
          `,
          [
            id,
            dto.roomId,
            dto.anchorId,
            dto.startsAt,
            dto.endsAt,
            dto.scheduleType,
            dto.makeupRequired,
            `LOCAL:${id}`,
            dto.notes ?? null,
            user.personId
          ]
        )
      ).rows[0]!;
      await this.replaceFieldControl(client, created, dto.fieldControlId);
      const recipients = this.unique([
        created.anchor_id,
        dto.fieldControlId
      ]);
      await this.enqueueScheduleNotifications(
        client,
        'LIVE_SESSION_CREATED',
        'LIVE_SESSION',
        created.id,
        created.version,
        recipients,
        '新增直播排班',
        '你有一条新的直播排班，请及时查看时间和直播间。',
        created
      );
      await this.audit(
        client,
        user.personId,
        'CREATE_LIVE_SESSION',
        'LIVE_SESSION',
        created.id,
        null,
        { ...created, fieldControlId: dto.fieldControlId ?? null }
      );
      return { session: created, recipients };
    });
    this.realtime.publish(
      'schedule.live.created',
      { liveSessionId: result.session.id },
      result.recipients,
      [result.session.room_id]
    );
    return result.session;
  }

  async updateLiveSession(
    user: CurrentUser,
    id: string,
    dto: SaveLiveSessionDto
  ) {
    const result = await this.db.transaction(async (client) => {
      const before = await this.liveSessionForUpdate(client, id);
      await this.lockResources(client, [
        `anchor:${before.anchor_id}`,
        `anchor:${dto.anchorId}`,
        `room:${before.room_id}`,
        `room:${dto.roomId}`,
        ...(dto.fieldControlId ? [`field-control:${dto.fieldControlId}`] : [])
      ]);
      await this.assertLiveResources(client, dto);
      await this.assertLiveConflicts(client, dto, id);
      const updated = (
        await client.query<LiveSessionRow>(
          `
            UPDATE live_sessions
            SET room_id=$2, anchor_id=$3, starts_at=$4, ends_at=$5,
                schedule_type=$6, makeup_required=$7, notes=$8,
                source_type='LOCAL_OVERRIDE', updated_by=$9,
                version=version+1, updated_at=now()
            WHERE id=$1 AND status='SCHEDULED' AND cancelled_at IS NULL
            RETURNING *
          `,
          [
            id,
            dto.roomId,
            dto.anchorId,
            dto.startsAt,
            dto.endsAt,
            dto.scheduleType,
            dto.makeupRequired,
            dto.notes ?? null,
            user.personId
          ]
        )
      ).rows[0];
      if (!updated) throw new ConflictException('直播场次状态已变化，请刷新后重试');
      const previousControl = await this.currentFieldControl(client, id);
      await this.replaceFieldControl(client, updated, dto.fieldControlId);
      const impacted = await this.flagAppointmentsForLiveChange(
        client,
        user.personId,
        before,
        updated
      );
      const recipients = this.unique([
        before.anchor_id,
        updated.anchor_id,
        previousControl,
        dto.fieldControlId,
        ...impacted.recipients
      ]);
      await this.enqueueScheduleNotifications(
        client,
        'LIVE_SESSION_UPDATED',
        'LIVE_SESSION',
        updated.id,
        updated.version,
        recipients,
        '直播排班已调整',
        '直播时间、直播间或参与人员发生调整，请打开系统确认最新安排。',
        updated
      );
      await this.audit(
        client,
        user.personId,
        'UPDATE_LIVE_SESSION',
        'LIVE_SESSION',
        id,
        before,
        { ...updated, fieldControlId: dto.fieldControlId ?? null }
      );
      return { session: updated, recipients, impactedCount: impacted.count };
    });
    this.realtime.publish(
      'schedule.live.updated',
      {
        liveSessionId: result.session.id,
        impactedAppointments: result.impactedCount
      },
      result.recipients,
      this.unique([result.session.room_id])
    );
    return {
      ...result.session,
      impactedAppointments: result.impactedCount
    };
  }

  async assignFieldControl(
    user: CurrentUser,
    liveSessionId: string,
    fieldControlId?: string
  ) {
    const result = await this.db.transaction(async (client) => {
      const sessionResult = await client.query<LiveSessionRow>(
        `
          SELECT * FROM live_sessions
          WHERE id=$1 AND source_type='FEISHU'
            AND status='SCHEDULED'
          FOR UPDATE
        `,
        [liveSessionId]
      );
      const session = sessionResult.rows[0];
      if (!session) {
        throw new NotFoundException('正式直播场次不存在或已失效');
      }
      const previousControl = await this.currentFieldControl(client, session.id);
      if (fieldControlId) {
        await this.lockResources(client, [`field-control:${fieldControlId}`]);
        const person = await client.query(
          `
            SELECT 1
            FROM people person
            JOIN person_roles role ON role.person_id=person.id
              AND role.role='FIELD_CONTROL' AND role.enabled
            WHERE person.id=$1 AND person.archived_at IS NULL
              AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
          `,
          [fieldControlId]
        );
        if (!person.rows[0]) throw new ConflictException('场控人员不可用');
        await this.assertFieldControlAvailability(client, {
          roomId: session.room_id,
          anchorId: session.anchor_id,
          fieldControlId,
          startsAt: session.starts_at.toISOString(),
          endsAt: session.ends_at.toISOString(),
          scheduleType: session.schedule_type as
            | 'LIVE'
            | 'REHEARSAL'
            | 'TRAINING',
          makeupRequired: session.makeup_required
        });
        const overlap = await client.query(
          `
            SELECT 1 FROM room_field_controls assignment
            WHERE assignment.person_id=$1 AND assignment.enabled
              AND assignment.live_session_id<>$2
              AND assignment.starts_at < $4
              AND assignment.ends_at > $3
            LIMIT 1
          `,
          [fieldControlId, session.id, session.starts_at, session.ends_at]
        );
        if (overlap.rows[0]) {
          throw new ConflictException('该场控在此时段已有其他直播间任务');
        }
      }
      await this.replaceFieldControl(client, session, fieldControlId);
      const recipients = this.unique([previousControl, fieldControlId]);
      await this.enqueueScheduleNotifications(
        client,
        'FIELD_CONTROL_ASSIGNED',
        'LIVE_SESSION',
        session.id,
        session.version,
        recipients,
        '场控安排已更新',
        fieldControlId
          ? '你负责的直播场次已更新，请查看直播间和时间。'
          : '你原负责的直播场次已解除场控安排。',
        session
      );
      await this.audit(
        client,
        user.personId,
        'ASSIGN_FIELD_CONTROL',
        'LIVE_SESSION',
        session.id,
        { fieldControlId: previousControl ?? null },
        { fieldControlId: fieldControlId ?? null }
      );
      return { session, recipients, previousControl };
    });
    this.realtime.publish(
      'schedule.field-control.updated',
      {
        liveSessionId: result.session.id,
        fieldControlId: fieldControlId ?? null
      },
      result.recipients,
      [result.session.room_id]
    );
    return {
      liveSessionId: result.session.id,
      fieldControlId: fieldControlId ?? null,
      previousFieldControlId: result.previousControl ?? null
    };
  }

  async cancelLiveSession(user: CurrentUser, id: string) {
    const result = await this.db.transaction(async (client) => {
      const before = await this.liveSessionForUpdate(client, id);
      const previousControl = await this.currentFieldControl(client, id);
      const cancelled = (
        await client.query<LiveSessionRow>(
          `
            UPDATE live_sessions
            SET status='CANCELLED', cancelled_at=now(),
                source_type='LOCAL_OVERRIDE', updated_by=$2,
                version=version+1, updated_at=now()
            WHERE id=$1 AND status='SCHEDULED' AND cancelled_at IS NULL
            RETURNING *
          `,
          [id, user.personId]
        )
      ).rows[0];
      if (!cancelled) throw new ConflictException('直播场次已取消或状态已变化');
      await client.query(
        `UPDATE room_field_controls SET enabled=false, updated_at=now()
         WHERE live_session_id=$1`,
        [id]
      );
      const impacted = await this.flagAppointmentsForLiveChange(
        client,
        user.personId,
        before,
        cancelled
      );
      const recipients = this.unique([
        before.anchor_id,
        previousControl,
        ...impacted.recipients
      ]);
      await this.enqueueScheduleNotifications(
        client,
        'LIVE_SESSION_CANCELLED',
        'LIVE_SESSION',
        id,
        cancelled.version,
        recipients,
        '直播排班已取消',
        '关联直播场次已取消；已有妆造预约已进入待处理状态。',
        cancelled
      );
      await this.audit(
        client,
        user.personId,
        'CANCEL_LIVE_SESSION',
        'LIVE_SESSION',
        id,
        before,
        cancelled
      );
      return { session: cancelled, recipients, impactedCount: impacted.count };
    });
    this.realtime.publish(
      'schedule.live.cancelled',
      {
        liveSessionId: id,
        impactedAppointments: result.impactedCount
      },
      result.recipients,
      [result.session.room_id]
    );
    return {
      ok: true,
      impactedAppointments: result.impactedCount
    };
  }

  async createStaffShift(user: CurrentUser, dto: SaveStaffShiftDto) {
    const id = randomUUID();
    const result = await this.db.transaction(async (client) => {
      await this.lockResources(client, [`staff:${dto.personId}:${dto.scheduleDate}`]);
      await this.assertPersonRole(client, dto.personId, dto.role);
      await this.assertNoStaffDayDuplicate(client, dto);
      const resolved = await this.resolveShift(client, dto);
      const person = await this.personName(client, dto.personId);
      const created = (
        await client.query<StaffShiftRow>(
          `
            INSERT INTO staff_daily_schedules(
              id, person_id, schedule_date, role, employment_status,
              raw_person_name, raw_shift_value, shift_template_id,
              starts_at, ends_at, is_rest, is_leave, is_bookable,
              parse_status, source_table_id, source_record_id,
              source_date_field_id, source_date_field_name, raw_data,
              source_type, notes, created_by, updated_by
            )
            SELECT
              $1::uuid,$2::uuid,$3::date,$4,p.employment_status,$5,$6,
              $7::uuid,$8::timestamptz,$9::timestamptz,$10,$11,$12,
              $13,'LOCAL',$1::uuid::text,$3::date::text,$3::date::text,
              '{}','LOCAL',$14,$15::uuid,$15::uuid
            FROM people p WHERE p.id=$2
            RETURNING *
          `,
          [
            id,
            dto.personId,
            dto.scheduleDate,
            dto.role,
            person,
            resolved.rawShiftValue,
            dto.shiftTemplateId ?? null,
            resolved.startsAt,
            resolved.endsAt,
            dto.isRest,
            dto.isLeave,
            resolved.isBookable,
            resolved.parseStatus,
            dto.notes ?? null,
            user.personId
          ]
        )
      ).rows[0]!;
      await this.replaceSegments(client, id, resolved.segments);
      await this.enqueueScheduleNotifications(
        client,
        'STAFF_SHIFT_CREATED',
        'STAFF_SCHEDULE',
        id,
        created.version,
        [dto.personId],
        '新增人员班次',
        `你在 ${dto.scheduleDate} 有一条新班次：${resolved.rawShiftValue}。`,
        created
      );
      await this.audit(
        client,
        user.personId,
        'CREATE_STAFF_SHIFT',
        'STAFF_SCHEDULE',
        id,
        null,
        created
      );
      return created;
    });
    this.realtime.publish(
      'schedule.staff.created',
      { scheduleId: result.id, scheduleDate: dto.scheduleDate },
      [dto.personId]
    );
    return result;
  }

  async updateStaffShift(
    user: CurrentUser,
    id: string,
    dto: SaveStaffShiftDto
  ) {
    const result = await this.db.transaction(async (client) => {
      const before = await this.staffShiftForUpdate(client, id);
      await this.lockResources(client, [
        `staff:${before.person_id}:${before.schedule_date}`,
        `staff:${dto.personId}:${dto.scheduleDate}`
      ]);
      await this.assertPersonRole(client, dto.personId, dto.role);
      await this.assertNoStaffDayDuplicate(client, dto, id);
      const resolved = await this.resolveShift(client, dto);
      const person = await this.personName(client, dto.personId);
      const updated = (
        await client.query<StaffShiftRow>(
          `
            UPDATE staff_daily_schedules schedule
            SET person_id=$2, schedule_date=$3, role=$4,
                employment_status=person.employment_status,
                raw_person_name=$5, raw_shift_value=$6,
                shift_template_id=$7, starts_at=$8, ends_at=$9,
                is_rest=$10, is_leave=$11, is_bookable=$12,
                parse_status='SUCCESS', parse_message=NULL,
                source_type='LOCAL_OVERRIDE', notes=$13,
                updated_by=$14, version=version+1, updated_at=now()
            FROM people person
            WHERE schedule.id=$1 AND person.id=$2
              AND schedule.cancelled_at IS NULL
            RETURNING schedule.*
          `,
          [
            id,
            dto.personId,
            dto.scheduleDate,
            dto.role,
            person,
            resolved.rawShiftValue,
            dto.shiftTemplateId ?? null,
            resolved.startsAt,
            resolved.endsAt,
            dto.isRest,
            dto.isLeave,
            resolved.isBookable,
            dto.notes ?? null,
            user.personId
          ]
        )
      ).rows[0];
      if (!updated) throw new ConflictException('人员班次状态已变化，请刷新后重试');
      await this.replaceSegments(client, id, resolved.segments);
      const recipients = this.unique([before.person_id, updated.person_id]);
      await this.enqueueScheduleNotifications(
        client,
        'STAFF_SHIFT_UPDATED',
        'STAFF_SCHEDULE',
        id,
        updated.version,
        recipients,
        '人员班次已调整',
        `你的 ${dto.scheduleDate} 班次已调整为：${resolved.rawShiftValue}。`,
        updated
      );
      await this.audit(
        client,
        user.personId,
        'UPDATE_STAFF_SHIFT',
        'STAFF_SCHEDULE',
        id,
        before,
        updated
      );
      return { shift: updated, recipients };
    });
    this.realtime.publish(
      'schedule.staff.updated',
      { scheduleId: id, scheduleDate: dto.scheduleDate },
      result.recipients
    );
    return result.shift;
  }

  async cancelStaffShift(user: CurrentUser, id: string) {
    const result = await this.db.transaction(async (client) => {
      const before = await this.staffShiftForUpdate(client, id);
      const cancelled = (
        await client.query<StaffShiftRow>(
          `
            UPDATE staff_daily_schedules
            SET cancelled_at=now(), is_bookable=false,
                source_type='LOCAL_OVERRIDE', updated_by=$2,
                version=version+1, updated_at=now()
            WHERE id=$1 AND cancelled_at IS NULL
            RETURNING *
          `,
          [id, user.personId]
        )
      ).rows[0];
      if (!cancelled) throw new ConflictException('人员班次已取消或状态已变化');
      await client.query(
        `UPDATE staff_schedule_segments
         SET bookable=false, updated_at=now() WHERE schedule_id=$1`,
        [id]
      );
      const impacted = await this.flagAppointmentsForShiftCancellation(
        client,
        user.personId,
        cancelled
      );
      const recipients = this.unique([
        cancelled.person_id,
        ...impacted.recipients
      ]);
      await this.enqueueScheduleNotifications(
        client,
        'STAFF_SHIFT_CANCELLED',
        'STAFF_SCHEDULE',
        id,
        cancelled.version,
        recipients,
        '人员班次已取消',
        '该班次已取消，相关妆造预约会进入待重新分配或风险处理。',
        cancelled
      );
      await this.audit(
        client,
        user.personId,
        'CANCEL_STAFF_SHIFT',
        'STAFF_SCHEDULE',
        id,
        before,
        cancelled
      );
      return { shift: cancelled, recipients, impactedCount: impacted.count };
    });
    this.realtime.publish(
      'schedule.staff.cancelled',
      { scheduleId: id, impactedAppointments: result.impactedCount },
      result.recipients
    );
    return { ok: true, impactedAppointments: result.impactedCount };
  }

  private async assertLiveResources(
    client: PoolClient,
    dto: SaveLiveSessionDto
  ): Promise<void> {
    this.assertRange(dto.startsAt, dto.endsAt);
    const durationHours =
      (new Date(dto.endsAt).getTime() - new Date(dto.startsAt).getTime()) /
      3_600_000;
    if (durationHours > 5) {
      throw new BadRequestException('主播单次直播不能超过5小时');
    }
    const room = await client.query(
      `SELECT id FROM rooms WHERE id=$1 AND enabled`,
      [dto.roomId]
    );
    if (!room.rows[0]) throw new BadRequestException('直播间不存在或已停用');
    await this.assertPersonRole(client, dto.anchorId, 'ANCHOR');
    if (dto.fieldControlId) {
      await this.assertPersonRole(client, dto.fieldControlId, 'FIELD_CONTROL');
    }
  }

  private async assertPersonRole(
    client: PoolClient,
    personId: string,
    role: string
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT p.id
        FROM people p
        JOIN person_roles pr ON pr.person_id=p.id
        WHERE p.id=$1 AND pr.role::text=$2 AND pr.enabled
          AND p.archived_at IS NULL
          AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
      `,
      [personId, role]
    );
    if (!result.rows[0]) {
      throw new BadRequestException('所选人员不存在、已停用或岗位不匹配');
    }
  }

  private async assertLiveConflicts(
    client: PoolClient,
    dto: SaveLiveSessionDto,
    excludeId?: string
  ): Promise<void> {
    const conflict = await client.query<{
      id: string;
      room_conflict: boolean;
      anchor_conflict: boolean;
    }>(
      `
        SELECT id, room_id=$1 AS room_conflict, anchor_id=$2 AS anchor_conflict
        FROM live_sessions
        WHERE status='SCHEDULED' AND cancelled_at IS NULL
          AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND ($5::uuid IS NULL OR id<>$5)
          AND (room_id=$1 OR anchor_id=$2)
          AND tstzrange(starts_at, ends_at, '[)') &&
              tstzrange($3::timestamptz, $4::timestamptz, '[)')
        LIMIT 1
      `,
      [dto.roomId, dto.anchorId, dto.startsAt, dto.endsAt, excludeId ?? null]
    );
    if (conflict.rows[0]?.room_conflict) {
      throw new ConflictException('该直播间在所选时间已有直播排班');
    }
    if (conflict.rows[0]?.anchor_conflict) {
      throw new ConflictException('该主播在所选时间已有直播排班');
    }
    if (dto.fieldControlId) {
      const controlConflict = await client.query(
        `
          SELECT id FROM room_field_controls
          WHERE person_id=$1 AND enabled
            AND ($4::uuid IS NULL OR live_session_id IS DISTINCT FROM $4)
            AND tstzrange(starts_at, ends_at, '[)') &&
                tstzrange($2::timestamptz, $3::timestamptz, '[)')
          LIMIT 1
        `,
        [dto.fieldControlId, dto.startsAt, dto.endsAt, excludeId ?? null]
      );
      if (controlConflict.rows[0]) {
        throw new ConflictException('该场控在所选时间已有直播间任务');
      }
      await this.assertFieldControlAvailability(client, dto);
    }
    await this.assertAnchorWorkRules(client, dto, excludeId);
  }

  private async assertAnchorWorkRules(
    client: PoolClient,
    dto: SaveLiveSessionDto,
    excludeId?: string
  ): Promise<void> {
    await this.assertAnchorAvailability(client, dto);
    await this.assertContinuousLiveLimit(client, dto, excludeId);

    const restConflict = await client.query(
      `
        SELECT id
        FROM live_sessions
        WHERE anchor_id=$1 AND status='SCHEDULED' AND cancelled_at IS NULL
          AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND ($4::uuid IS NULL OR id<>$4)
          AND (starts_at AT TIME ZONE 'Asia/Shanghai')::date <>
              ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
          AND (
            (ends_at <= $2::timestamptz AND
             $2::timestamptz - ends_at < interval '8 hours')
            OR
            (starts_at >= $3::timestamptz AND
             starts_at - $3::timestamptz < interval '8 hours')
          )
        LIMIT 1
      `,
      [dto.anchorId, dto.startsAt, dto.endsAt, excludeId ?? null]
    );
    if (restConflict.rows[0]) {
      throw new ConflictException('该主播跨日相邻直播的休息间隔不能低于8小时');
    }

    const employment = await client.query<{ employment_type: string }>(
      `SELECT employment_type FROM people WHERE id=$1`,
      [dto.anchorId]
    );
    if (employment.rows[0]?.employment_type === 'FULL_TIME') {
      const candidate = {
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt)
      };
      for (const month of this.shanghaiMonths(candidate.startsAt, candidate.endsAt)) {
        const bounds = this.shanghaiMonthBounds(month);
        const existing = await client.query<{ total_hours: number }>(
          `
            SELECT COALESCE(sum(extract(epoch FROM (
                     LEAST(ends_at, $3::timestamptz) -
                     GREATEST(starts_at, $2::timestamptz)
                   ))/3600),0)::float8 AS total_hours
            FROM live_sessions
            WHERE anchor_id=$1 AND status='SCHEDULED'
              AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
              AND cancelled_at IS NULL
              AND ($4::uuid IS NULL OR id<>$4)
              AND ends_at>$2::timestamptz AND starts_at<$3::timestamptz
          `,
          [dto.anchorId, bounds.start, bounds.end, excludeId ?? null]
        );
        const candidateMonthHours =
          Math.max(
            0,
            Math.min(candidate.endsAt.getTime(), bounds.end.getTime()) -
              Math.max(candidate.startsAt.getTime(), bounds.start.getTime())
          ) / 3_600_000;
        if (
          Number(existing.rows[0]?.total_hours ?? 0) + candidateMonthHours >
          130 + 1e-9
        ) {
          throw new ConflictException(
            `该全职主播${month}月累计直播不能超过130小时`
          );
        }
      }
    }
  }

  private async assertContinuousLiveLimit(
    client: PoolClient,
    dto: SaveLiveSessionDto,
    excludeId?: string
  ): Promise<void> {
    const nearby = await client.query<{ starts_at: Date; ends_at: Date }>(
      `
        SELECT starts_at, ends_at
        FROM live_sessions
        WHERE anchor_id=$1 AND status='SCHEDULED' AND cancelled_at IS NULL
          AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND ($4::uuid IS NULL OR id<>$4)
          AND ends_at >= $2::timestamptz - interval '5 hours'
          AND starts_at <= $3::timestamptz + interval '5 hours'
        ORDER BY starts_at
      `,
      [dto.anchorId, dto.startsAt, dto.endsAt, excludeId ?? null]
    );

    let continuousStart = new Date(dto.startsAt).getTime();
    let continuousEnd = new Date(dto.endsAt).getTime();
    const ranges = nearby.rows.map((item) => ({
      startsAt: item.starts_at.getTime(),
      endsAt: item.ends_at.getTime()
    }));

    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const range of ranges) {
        if (range.startsAt > continuousEnd || range.endsAt < continuousStart) {
          continue;
        }
        const nextStart = Math.min(continuousStart, range.startsAt);
        const nextEnd = Math.max(continuousEnd, range.endsAt);
        if (nextStart !== continuousStart || nextEnd !== continuousEnd) {
          continuousStart = nextStart;
          continuousEnd = nextEnd;
          expanded = true;
        }
      }
    }

    const continuousHours = (continuousEnd - continuousStart) / 3_600_000;
    if (continuousHours > 5 + 1e-9) {
      throw new ConflictException('该主播单次连续直播不能超过5小时');
    }
  }

  private async assertAnchorAvailability(
    client: PoolClient,
    dto: SaveLiveSessionDto
  ): Promise<void> {
    const shifts = await client.query<{
      is_rest: boolean;
      is_leave: boolean;
      is_bookable: boolean;
      parse_status: string;
      starts_at: Date | null;
      ends_at: Date | null;
    }>(
      `
        SELECT schedule.is_rest, schedule.is_leave,
               schedule.is_bookable AND COALESCE(segment.bookable, true)
                 AS is_bookable,
               schedule.parse_status::text,
               COALESCE(segment.starts_at, schedule.starts_at) AS starts_at,
               COALESCE(segment.ends_at, schedule.ends_at) AS ends_at
        FROM staff_daily_schedules schedule
        LEFT JOIN staff_schedule_segments segment
          ON segment.schedule_id=schedule.id
        WHERE schedule.person_id=$1 AND schedule.role='ANCHOR'
          AND schedule.source_type IN (
            'FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN'
          )
          AND schedule.cancelled_at IS NULL
          AND schedule.schedule_date=
              ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
      `,
      [dto.anchorId, dto.startsAt]
    );
    if (!shifts.rowCount) {
      throw new ConflictException('该主播当天没有可用于直播的人员班次');
    }
    if (
      shifts.rows.some(
        (item) =>
          item.is_rest ||
          item.is_leave ||
          item.parse_status !== 'SUCCESS'
      )
    ) {
      throw new ConflictException('该主播当天休息、请假或班次不可用于直播');
    }
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (
      !shifts.rows.some(
        (item) =>
          item.starts_at &&
          item.ends_at &&
          item.is_bookable &&
          item.starts_at <= startsAt &&
          item.ends_at >= endsAt
      )
    ) {
      throw new ConflictException('该主播的有效班次未完整覆盖直播时段');
    }
  }

  private async assertFieldControlAvailability(
    client: PoolClient,
    dto: SaveLiveSessionDto
  ): Promise<void> {
    if (!dto.fieldControlId) return;
    const shifts = await client.query<{
      is_rest: boolean;
      is_leave: boolean;
      is_bookable: boolean;
      parse_status: string;
      starts_at: Date | null;
      ends_at: Date | null;
    }>(
      `
        SELECT schedule.is_rest, schedule.is_leave,
               schedule.is_bookable AND COALESCE(segment.bookable, true)
                 AS is_bookable,
               schedule.parse_status::text,
               COALESCE(segment.starts_at, schedule.starts_at) AS starts_at,
               COALESCE(segment.ends_at, schedule.ends_at) AS ends_at
        FROM staff_daily_schedules schedule
        LEFT JOIN staff_schedule_segments segment
          ON segment.schedule_id=schedule.id
        WHERE schedule.person_id=$1 AND schedule.role='FIELD_CONTROL'
          AND schedule.source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND schedule.cancelled_at IS NULL
          AND schedule.schedule_date=
              ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
      `,
      [dto.fieldControlId, dto.startsAt]
    );
    if (!shifts.rowCount) {
      throw new ConflictException('该场控当天没有可用于直播的人员班次');
    }
    if (
      shifts.rows.some(
        (item) =>
          item.is_rest ||
          item.is_leave ||
          item.parse_status !== 'SUCCESS'
      )
    ) {
      throw new ConflictException('该场控当天休息、请假或班次不可用于直播');
    }
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (
      !shifts.rows.some(
        (item) =>
          item.starts_at &&
          item.ends_at &&
          item.is_bookable &&
          item.starts_at <= startsAt &&
          item.ends_at >= endsAt
      )
    ) {
      throw new ConflictException('该场控的有效班次未完整覆盖直播时段');
    }
  }

  private async replaceFieldControl(
    client: PoolClient,
    session: LiveSessionRow,
    fieldControlId?: string
  ): Promise<void> {
    await client.query(
      `UPDATE room_field_controls SET enabled=false, updated_at=now()
       WHERE live_session_id=$1`,
      [session.id]
    );
    if (!fieldControlId) return;
    await client.query(
      `
        INSERT INTO room_field_controls(
          room_id, person_id, starts_at, ends_at, live_session_id, enabled
        )
        VALUES ($1,$2,$3,$4,$5,true)
        ON CONFLICT (live_session_id, person_id)
          WHERE live_session_id IS NOT NULL
        DO UPDATE SET room_id=EXCLUDED.room_id,
          starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
          enabled=true, updated_at=now()
      `,
      [
        session.room_id,
        fieldControlId,
        session.starts_at,
        session.ends_at,
        session.id
      ]
    );
  }

  private async currentFieldControl(
    client: PoolClient,
    sessionId: string
  ): Promise<string | undefined> {
    const result = await client.query<{ person_id: string }>(
      `
        SELECT person_id FROM room_field_controls
        WHERE live_session_id=$1 AND enabled
        ORDER BY updated_at DESC LIMIT 1
      `,
      [sessionId]
    );
    return result.rows[0]?.person_id;
  }

  private async liveSessionForUpdate(
    client: PoolClient,
    id: string
  ): Promise<LiveSessionRow> {
    const result = await client.query<LiveSessionRow>(
      `SELECT * FROM live_sessions
       WHERE id=$1
         AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
       FOR UPDATE`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('直播场次不存在');
    if (
      result.rows[0].status !== 'SCHEDULED' ||
      (result.rows[0] as LiveSessionRow & { cancelled_at?: Date }).cancelled_at
    ) {
      throw new ConflictException('该直播场次已不可编辑');
    }
    return result.rows[0];
  }

  private async staffShiftForUpdate(
    client: PoolClient,
    id: string
  ): Promise<StaffShiftRow> {
    const result = await client.query<StaffShiftRow>(
      `SELECT * FROM staff_daily_schedules
       WHERE id=$1
         AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
       FOR UPDATE`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('人员班次不存在');
    if ((result.rows[0] as StaffShiftRow & { cancelled_at?: Date }).cancelled_at) {
      throw new ConflictException('该人员班次已取消');
    }
    return result.rows[0];
  }

  private async assertNoStaffDayDuplicate(
    client: PoolClient,
    dto: SaveStaffShiftDto,
    excludeId?: string
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT id FROM staff_daily_schedules
        WHERE person_id=$1 AND schedule_date=$2::date AND role::text=$3
          AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND cancelled_at IS NULL
          AND ($4::uuid IS NULL OR id<>$4)
        LIMIT 1
      `,
      [dto.personId, dto.scheduleDate, dto.role, excludeId ?? null]
    );
    if (result.rows[0]) {
      throw new ConflictException('该人员当天已有班次，请直接编辑原班次');
    }
  }

  private async resolveShift(
    client: PoolClient,
    dto: SaveStaffShiftDto
  ): Promise<ShiftResolution> {
    if (dto.isRest && dto.isLeave) {
      throw new BadRequestException('休息和请假不能同时选择');
    }
    if (dto.isRest || dto.isLeave) {
      return {
        rawShiftValue:
          dto.rawShiftValue?.trim() || (dto.isLeave ? '请假' : '休息'),
        startsAt: null,
        endsAt: null,
        isBookable: false,
        parseStatus: 'SUCCESS',
        segments: []
      };
    }
    let template: ShiftTemplateRow | undefined;
    if (dto.shiftTemplateId) {
      template = (
        await client.query<ShiftTemplateRow>(
          `SELECT * FROM shift_templates WHERE id=$1 AND enabled`,
          [dto.shiftTemplateId]
        )
      ).rows[0];
      if (!template) throw new BadRequestException('班次模板不存在或已停用');
    }
    let startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    let endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    let segments: ShiftResolution['segments'] = [];
    const templateSegments = this.templateSegments(template?.segments);
    if (!startsAt && !endsAt && templateSegments.length) {
      segments = templateSegments.map((segment) => ({
        startsAt: this.atShanghai(dto.scheduleDate, segment.startTime),
        endsAt: this.atShanghai(
          segment.crossesMidnight
            ? this.nextDate(dto.scheduleDate)
            : dto.scheduleDate,
          segment.endTime
        ),
        bookable: template?.bookable ?? true
      }));
      startsAt = segments[0]?.startsAt ?? null;
      endsAt = segments.at(-1)?.endsAt ?? null;
    } else if (!startsAt && !endsAt && template?.start_time && template.end_time) {
      startsAt = this.atShanghai(dto.scheduleDate, template.start_time);
      endsAt = this.atShanghai(
        template.crosses_midnight ? this.nextDate(dto.scheduleDate) : dto.scheduleDate,
        template.end_time
      );
    }
    if (startsAt && !endsAt && template?.duration_minutes) {
      endsAt = new Date(
        startsAt.getTime() + template.duration_minutes * 60_000
      );
    }
    if (!startsAt || !endsAt) {
      throw new BadRequestException('该班次需要填写明确的开始和结束时间');
    }
    this.assertRange(startsAt.toISOString(), endsAt.toISOString());
    if (!segments.length) {
      segments = [{ startsAt, endsAt, bookable: template?.bookable ?? true }];
    }
    return {
      rawShiftValue:
        dto.rawShiftValue?.trim() || template?.name || '自定义班次',
      startsAt,
      endsAt,
      isBookable: template?.bookable ?? true,
      parseStatus: 'SUCCESS',
      segments
    };
  }

  private templateSegments(
    value: unknown
  ): Array<{ startTime: string; endTime: string; crossesMidnight?: boolean }> {
    const parsed =
      typeof value === 'string'
        ? (JSON.parse(value) as unknown)
        : value;
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const startTime = record['startTime'];
      const endTime = record['endTime'];
      if (typeof startTime !== 'string' || typeof endTime !== 'string') {
        return [];
      }
      return [
        {
          startTime,
          endTime,
          ...(typeof record['crossesMidnight'] === 'boolean'
            ? { crossesMidnight: record['crossesMidnight'] }
            : {})
        }
      ];
    });
  }

  private async replaceSegments(
    client: PoolClient,
    scheduleId: string,
    segments: ShiftResolution['segments']
  ): Promise<void> {
    await client.query(
      `DELETE FROM staff_schedule_segments WHERE schedule_id=$1`,
      [scheduleId]
    );
    for (const [index, segment] of segments.entries()) {
      await client.query(
        `
          INSERT INTO staff_schedule_segments(
            schedule_id, segment_index, starts_at, ends_at, bookable
          ) VALUES ($1,$2,$3,$4,$5)
        `,
        [
          scheduleId,
          index,
          segment.startsAt,
          segment.endsAt,
          segment.bookable
        ]
      );
    }
  }

  private async flagAppointmentsForLiveChange(
    client: PoolClient,
    actorId: string,
    before: LiveSessionRow,
    after: LiveSessionRow
  ): Promise<{ count: number; recipients: string[] }> {
    const appointments = await client.query<AppointmentImpactRow>(
      `
        SELECT id, status::text, anchor_id, makeup_artist_id, requester_id,
               data_version, planned_end_at
        FROM makeup_appointments
        WHERE live_session_id=$1
          AND source_type<>'FEISHU'
          AND status IN ('BOOKED','IN_PROGRESS','RESCHEDULE_REQUIRED',
                         'REASSIGN_REQUIRED','COMPLETED')
        FOR UPDATE
      `,
      [after.id]
    );
    const recipients: string[] = [];
    for (const appointment of appointments.rows) {
      recipients.push(
        appointment.anchor_id,
        appointment.makeup_artist_id,
        appointment.requester_id
      );
      const targetStatus =
        before.anchor_id !== after.anchor_id
          ? 'REASSIGN_REQUIRED'
          : 'RESCHEDULE_REQUIRED';
      if (appointment.status === 'BOOKED') {
        const updated = await client.query<{ data_version: number }>(
          `
            UPDATE makeup_appointments
            SET status=$2, data_version=data_version+1, updated_at=now()
            WHERE id=$1 AND status='BOOKED'
            RETURNING data_version
          `,
          [appointment.id, targetStatus]
        );
        if (updated.rows[0]) {
          await client.query(
            `
              INSERT INTO appointment_status_logs(
                appointment_id, from_status, to_status, actor_id, action, details
              )
              VALUES ($1,'BOOKED',$2,$3,'LIVE_SESSION_CHANGED',$4)
            `,
            [
              appointment.id,
              targetStatus,
              actorId,
              JSON.stringify({
                before: {
                  roomId: before.room_id,
                  anchorId: before.anchor_id,
                  startsAt: before.starts_at,
                  endsAt: before.ends_at
                },
                after: {
                  roomId: after.room_id,
                  anchorId: after.anchor_id,
                  startsAt: after.starts_at,
                  endsAt: after.ends_at,
                  status: after.status
                }
              })
            ]
          );
          await this.enqueueAppointmentWrite(
            client,
            appointment.id,
            updated.rows[0].data_version,
            targetStatus
          );
        }
      }
      await client.query(
        `
          INSERT INTO risk_items(
            risk_type, severity, title, description, appointment_id,
            live_session_id, room_id, person_id, suggestion,
            source_type, fingerprint, due_at, metadata
          )
          VALUES (
            'LIVE_SESSION_CHANGED','WARNING','直播排班变更影响妆造预约',
            '直播时间、直播间、主播或场次状态发生变化，需要重新确认妆造安排。',
            $1,$2,$3,$4,'重新计算妆造时间并确认化妆师可用性',
            'USER',$5,$6,$7
          )
          ON CONFLICT (fingerprint) DO NOTHING
        `,
        [
          appointment.id,
          after.id,
          after.room_id,
          appointment.anchor_id,
          `LIVE_SESSION_CHANGED:${after.id}:${after.version}:${appointment.id}`,
          after.starts_at,
          JSON.stringify({ before, after })
        ]
      );
    }
    return { count: appointments.rows.length, recipients: this.unique(recipients) };
  }

  private async flagAppointmentsForShiftCancellation(
    client: PoolClient,
    actorId: string,
    shift: StaffShiftRow
  ): Promise<{ count: number; recipients: string[] }> {
    if (shift.role !== 'MAKEUP_ARTIST' || !shift.starts_at || !shift.ends_at) {
      return { count: 0, recipients: [] };
    }
    const appointments = await client.query<AppointmentImpactRow>(
      `
        SELECT id, status::text, anchor_id, makeup_artist_id, requester_id,
               data_version, planned_end_at
        FROM makeup_appointments
        WHERE makeup_artist_id=$1 AND status='BOOKED'
          AND source_type<>'FEISHU'
          AND tstzrange(planned_start_at, planned_end_at, '[)') &&
              tstzrange($2, $3, '[)')
        FOR UPDATE
      `,
      [shift.person_id, shift.starts_at, shift.ends_at]
    );
    const recipients: string[] = [];
    for (const appointment of appointments.rows) {
      const updated = await client.query<{ data_version: number }>(
        `
          UPDATE makeup_appointments
          SET status='REASSIGN_REQUIRED', data_version=data_version+1,
              updated_at=now()
          WHERE id=$1 AND status='BOOKED'
          RETURNING data_version
        `,
        [appointment.id]
      );
      if (!updated.rows[0]) continue;
      recipients.push(
        appointment.anchor_id,
        appointment.makeup_artist_id,
        appointment.requester_id
      );
      await client.query(
        `
          INSERT INTO appointment_status_logs(
            appointment_id, from_status, to_status, actor_id, action, details
          )
          VALUES (
            $1,'BOOKED','REASSIGN_REQUIRED',$2,'MAKEUP_SHIFT_CANCELLED',$3
          )
        `,
        [
          appointment.id,
          actorId,
          JSON.stringify({ scheduleId: shift.id })
        ]
      );
      await this.enqueueAppointmentWrite(
        client,
        appointment.id,
        updated.rows[0].data_version,
        'REASSIGN_REQUIRED'
      );
      await client.query(
        `
          INSERT INTO risk_items(
            risk_type, severity, title, description, appointment_id,
            person_id, suggestion, source_type, fingerprint, metadata
          )
          VALUES (
            'MAKEUP_SHIFT_CANCELLED','URGENT','化妆师班次取消影响预约',
            '化妆师班次已取消，已有预约需要重新分配。',
            $1,$2,'立即选择其他可用化妆师','USER',$3,$4
          )
          ON CONFLICT (fingerprint) DO NOTHING
        `,
        [
          appointment.id,
          shift.person_id,
          `MAKEUP_SHIFT_CANCELLED:${shift.id}:${shift.version}:${appointment.id}`,
          JSON.stringify({ scheduleId: shift.id })
        ]
      );
    }
    return { count: appointments.rows.length, recipients: this.unique(recipients) };
  }

  private async enqueueAppointmentWrite(
    client: PoolClient,
    appointmentId: string,
    version: number,
    status: string
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO feishu_write_outbox(
          operation, aggregate_type, aggregate_id, idempotency_key, payload
        )
        VALUES ('UPSERT_APPOINTMENT','MAKEUP_APPOINTMENT',$1,$2,$3)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        appointmentId,
        `UPSERT_APPOINTMENT:${appointmentId}:${version}`,
        JSON.stringify({ id: appointmentId, status, data_version: version })
      ]
    );
  }

  private async enqueueScheduleNotifications(
    client: PoolClient,
    eventType: string,
    aggregateType: 'LIVE_SESSION' | 'STAFF_SCHEDULE',
    aggregateId: string,
    version: number,
    recipients: Array<string | undefined>,
    title: string,
    body: string,
    payload: unknown
  ): Promise<void> {
    for (const recipient of this.unique(recipients)) {
      const key = `${eventType}:${aggregateId}:${recipient}:${version}`;
      await client.query(
        `
          INSERT INTO notification_outbox(
            event_type, aggregate_type, aggregate_id, recipient_person_id,
            idempotency_key, payload
          )
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          eventType,
          aggregateType,
          aggregateId,
          recipient,
          key,
          JSON.stringify(payload)
        ]
      );
      await client.query(
        `
          INSERT INTO notifications(
            recipient_person_id, event_type, title, body,
            resource_type, resource_id, severity, idempotency_key, metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,'INFO',$7,$8)
          ON CONFLICT DO NOTHING
        `,
        [
          recipient,
          eventType,
          title,
          body,
          aggregateType,
          aggregateId,
          key,
          JSON.stringify({ version })
        ]
      );
    }
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    before: unknown,
    after: unknown
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO operation_logs(
          actor_id, action, resource_type, resource_id, before_data, after_data
        ) VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        actorId,
        action,
        resourceType,
        resourceId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null
      ]
    );
  }

  private async personName(
    client: PoolClient,
    personId: string
  ): Promise<string> {
    const result = await client.query<{ display_name: string }>(
      `SELECT display_name FROM people WHERE id=$1`,
      [personId]
    );
    if (!result.rows[0]) throw new BadRequestException('人员不存在');
    return result.rows[0].display_name;
  }

  private async lockResources(
    client: PoolClient,
    keys: string[]
  ): Promise<void> {
    for (const key of [...new Set(keys)].sort()) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
    }
  }

  private shanghaiMonths(startsAt: Date, endsAt: Date): string[] {
    const offsetMs = 8 * 60 * 60 * 1000;
    const startMonth = new Date(startsAt.getTime() + offsetMs)
      .toISOString()
      .slice(0, 7);
    const lastIncluded = new Date(endsAt.getTime() - 1);
    const endMonth = new Date(lastIncluded.getTime() + offsetMs)
      .toISOString()
      .slice(0, 7);
    return startMonth === endMonth ? [startMonth] : [startMonth, endMonth];
  }

  private shanghaiMonthBounds(month: string): { start: Date; end: Date } {
    const [year, monthNumber] = month.split('-').map(Number);
    const nextMonth =
      monthNumber === 12
        ? `${year! + 1}-01`
        : `${year}-${String(monthNumber! + 1).padStart(2, '0')}`;
    return {
      start: new Date(`${month}-01T00:00:00+08:00`),
      end: new Date(`${nextMonth}-01T00:00:00+08:00`)
    };
  }

  private assertRange(start: string, end: string): void {
    const startsAt = new Date(start);
    const endsAt = new Date(end);
    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }
    if (endsAt.getTime() - startsAt.getTime() > 36 * 60 * 60 * 1000) {
      throw new BadRequestException('单条排班不能超过36小时');
    }
  }

  private atShanghai(date: string, time: string): Date {
    const normalized = time.slice(0, 8);
    return new Date(`${date}T${normalized}+08:00`);
  }

  private nextDate(date: string): string {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
  }

  private unique(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))];
  }
}
