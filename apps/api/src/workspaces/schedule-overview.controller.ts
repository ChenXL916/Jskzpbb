import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query
} from '@nestjs/common';
import { CurrentUser as CurrentUserType, PersonRole } from '@jishi/contracts';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches
} from 'class-validator';
import { CurrentUser, Roles } from '../common/auth.decorators';
import { DatabaseService } from '../database/database.service';
import { FeishuSyncService } from '../feishu/feishu-sync.service';

const overviewRoles: PersonRole[] = [
  'LIVE_SUPERVISOR',
  'ADMIN',
  'DEVELOPER'
];

class MonthlyScheduleQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;

  @IsOptional()
  @IsIn(['ANCHOR', 'MAKEUP_ARTIST', 'FIELD_CONTROL'])
  role?: 'ANCHOR' | 'MAKEUP_ARTIST' | 'FIELD_CONTROL';

  @IsOptional()
  @IsString()
  employmentStatus?: string;
}

class LiveBoardQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsOptional()
  @Matches(/^[0-9a-f-]{36}$/i)
  roomId?: string;
}

class AppointmentLedgerQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

interface MonthlyScheduleRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  display_name: string;
  role: 'ANCHOR' | 'MAKEUP_ARTIST' | 'FIELD_CONTROL';
  employment_status: string | null;
  schedule_date: string;
  raw_shift_value: string;
  starts_at: Date | null;
  ends_at: Date | null;
  parse_status: string;
  is_rest: boolean;
  is_leave: boolean;
  shift_template_id: string | null;
  source_type: string;
  notes: string | null;
}

interface MonthlyLiveSessionRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  display_name: string;
  employment_status: string | null;
  schedule_date: string;
  room_id: string;
  room_name: string;
  starts_at: Date;
  ends_at: Date;
  schedule_type: string;
}

interface MonthlyLiveSession {
  id: string;
  roomId: string;
  roomName: string;
  startsAt: Date;
  endsAt: Date;
  scheduleType: string;
}

interface MonthlyDay {
  id?: string;
  raw: string;
  startsAt: Date | null;
  endsAt: Date | null;
  parseStatus: string;
  isRest: boolean;
  isLeave?: boolean;
  shiftTemplateId?: string | null;
  sourceType?: string;
  notes?: string | null;
  source: 'STAFF_SCHEDULE' | 'LIVE_SCHEDULE';
  liveSessions?: MonthlyLiveSession[];
}

interface MonthlyPerson {
  id: string;
  name: string;
  role: string;
  employmentStatus: string | null;
  days: Record<string, MonthlyDay>;
}

@Controller('schedules')
@Roles(...overviewRoles)
export class ScheduleOverviewController {
  constructor(
    private readonly db: DatabaseService,
    private readonly feishuSync: FeishuSyncService
  ) {}

  @Get('source-status')
  async sourceStatus() {
    const [authority, mappings] = await Promise.all([
      this.db.query<{ value: string }>(
        `SELECT value #>> '{}' AS value FROM system_settings WHERE key='schedule.data_authority'`
      ),
      this.db.query<{
        table_id: string;
        table_name: string;
        business_type: string;
        enabled: boolean;
        field_mapping_count: number;
        last_synced_at: Date | null;
      }>(
        `
          SELECT tm.table_id, tm.table_name, tm.business_type, tm.enabled,
                 count(fm.id)::int AS field_mapping_count,
                 tm.last_synced_at
          FROM feishu_table_mappings tm
          LEFT JOIN feishu_field_mappings fm ON fm.table_mapping_id=tm.id
          WHERE tm.business_type IN (
            'STAFF_MONTHLY_SCHEDULE',
            'LIVE_ROOM_MONTHLY_SCHEDULE'
          )
          GROUP BY tm.id
          ORDER BY CASE tm.business_type
            WHEN 'STAFF_MONTHLY_SCHEDULE' THEN 1 ELSE 2 END
        `
      )
    ]);
    return {
      dataAuthority:
        authority.rows[0]?.value ?? 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS',
      scheduleEditable: false,
      tables: mappings.rows,
      lastSyncedAt:
        mappings.rows
          .map((mapping) => mapping.last_synced_at)
          .filter((value): value is Date => Boolean(value))
          .sort((left, right) => right.getTime() - left.getTime())[0] ?? null
    };
  }

  @Post('sync-feishu')
  syncFeishu() {
    return this.feishuSync.runAll('MANUAL');
  }

  @Get('monthly')
  async monthly(@Query() query: MonthlyScheduleQueryDto) {
    const [year, month] = query.month.split('-').map(Number);
    const start = `${query.month}-01`;
    const next =
      month === 12
        ? `${year! + 1}-01-01`
        : `${year}-${String(month! + 1).padStart(2, '0')}-01`;
    const [staffRows, liveRows] = await Promise.all([
      this.db.query<MonthlyScheduleRow>(
        `
          SELECT s.id, s.person_id, p.display_name, s.role, s.employment_status,
                 s.schedule_date::text, s.raw_shift_value, s.starts_at, s.ends_at,
                 s.parse_status, s.is_rest, s.is_leave, s.shift_template_id,
                 s.source_type, s.notes
          FROM staff_daily_schedules s
          LEFT JOIN people p ON p.id=s.person_id
          WHERE s.schedule_date >= $1::date AND s.schedule_date < $2::date
            AND s.cancelled_at IS NULL
            AND s.source_type='FEISHU'
            AND s.role <> 'ANCHOR'
            AND ($3::text IS NULL OR s.role::text=$3)
            AND ($4::text IS NULL OR s.employment_status=$4)
          ORDER BY
            CASE s.role
              WHEN 'FIELD_CONTROL' THEN 1
              WHEN 'MAKEUP_ARTIST' THEN 2
              ELSE 3
            END,
            COALESCE(p.display_name, s.raw_person_name),
            s.schedule_date
        `,
        [start, next, query.role ?? null, query.employmentStatus ?? null]
      ),
      this.db.query<MonthlyLiveSessionRow>(
        `
          SELECT ls.id, ls.anchor_id AS person_id, p.display_name,
                 COALESCE(day_profile.employment_status, p.employment_status)
                   AS employment_status,
                 (ls.starts_at AT TIME ZONE 'Asia/Shanghai')::date::text
                   AS schedule_date,
                 ls.room_id, r.name AS room_name, ls.starts_at, ls.ends_at,
                 ls.schedule_type, ls.source_type, ls.notes
          FROM live_sessions ls
          JOIN people p ON p.id=ls.anchor_id
          JOIN rooms r ON r.id=ls.room_id
          LEFT JOIN LATERAL (
            SELECT s.employment_status
            FROM staff_daily_schedules s
            WHERE s.person_id=ls.anchor_id
              AND s.role='ANCHOR'
              AND s.source_type='FEISHU'
              AND s.schedule_date=
                (ls.starts_at AT TIME ZONE 'Asia/Shanghai')::date
            ORDER BY s.updated_at DESC
            LIMIT 1
          ) day_profile ON true
          WHERE (ls.starts_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
            AND (ls.starts_at AT TIME ZONE 'Asia/Shanghai')::date < $2::date
            AND ls.status='SCHEDULED'
            AND ls.source_type='FEISHU'
            AND ($3::text IS NULL OR $3='ANCHOR')
            AND (
              $4::text IS NULL
              OR COALESCE(day_profile.employment_status, p.employment_status)=$4
            )
          ORDER BY p.display_name, ls.starts_at, r.name
        `,
        [start, next, query.role ?? null, query.employmentStatus ?? null]
      )
    ]);

    const people = new Map<string, MonthlyPerson>();
    for (const row of staffRows.rows) {
      // 主播月表始终以直播间小时排班为准，不能回退到人员表中的自由班。
      if (row.role === 'ANCHOR') continue;
      const key = `${row.person_id ?? row.display_name}:${row.role}`;
      const person = people.get(key) ?? {
        id: row.person_id ?? key,
        name: row.display_name ?? '待匹配人员',
        role: row.role,
        employmentStatus: row.employment_status,
        days: {}
      };
      person.days[String(Number(row.schedule_date.slice(-2)))] = {
        id: row.id,
        raw: row.raw_shift_value,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        parseStatus: row.parse_status,
        isRest: row.is_rest,
        isLeave: row.is_leave,
        shiftTemplateId: row.shift_template_id,
        sourceType: row.source_type,
        notes: row.notes,
        source: 'STAFF_SCHEDULE'
      };
      people.set(key, person);
    }

    for (const row of liveRows.rows) {
      const key = `${row.person_id}:ANCHOR`;
      const person = people.get(key) ?? {
        id: row.person_id,
        name: row.display_name,
        role: 'ANCHOR',
        employmentStatus: row.employment_status,
        days: {}
      };
      const dayKey = String(Number(row.schedule_date.slice(-2)));
      const current = person.days[dayKey];
      const liveSessions = current?.liveSessions ?? [];
      liveSessions.push({
        id: row.id,
        roomId: row.room_id,
        roomName: row.room_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        scheduleType: row.schedule_type
      });
      person.days[dayKey] = {
        raw: '',
        startsAt: liveSessions[0]?.startsAt ?? null,
        endsAt: liveSessions.at(-1)?.endsAt ?? null,
        parseStatus: 'SUCCESS',
        isRest: false,
        source: 'LIVE_SCHEDULE',
        liveSessions
      };
      people.set(key, person);
    }

    return {
      month: query.month,
      dayCount: new Date(year!, month!, 0).getDate(),
      sourceMode:
        query.role === 'ANCHOR'
          ? 'ANCHOR_LIVE_SCHEDULE'
          : query.role
            ? 'STAFF_DAILY_SCHEDULE'
            : 'MIXED',
      people: [...people.values()]
    };
  }

  @Get('live-board')
  async liveBoard(
    @CurrentUser() user: CurrentUserType,
    @Query() query: LiveBoardQueryDto
  ) {
    this.assertRoomAccess(user, query.roomId);
    const allowedRoomIds = this.canViewAll(user) ? null : user.roomIds;
    const [rooms, sessions, fieldControls] = await Promise.all([
      this.db.query(
        `
          SELECT id, name
          FROM rooms
          WHERE enabled
            AND ($1::uuid[] IS NULL OR id=ANY($1::uuid[]))
            AND ($2::uuid IS NULL OR id=$2)
          ORDER BY name
        `,
        [allowedRoomIds, query.roomId ?? null]
      ),
      this.db.query(
        `
          SELECT ls.id, ls.room_id, r.name AS room_name,
                 ls.anchor_id, anchor.display_name AS anchor_name,
                 ls.starts_at, ls.ends_at, ls.schedule_type, ls.status,
                 ls.makeup_required, ls.source_type, ls.notes, ls.version,
                 field_control.person_id AS field_control_id,
                 control_person.display_name AS field_control_name,
                 appointment.id AS appointment_id,
                 appointment.status AS appointment_status,
                 artist.display_name AS makeup_artist_name,
                 appointment.planned_start_at,
                 appointment.planned_end_at
          FROM live_sessions ls
          JOIN rooms r ON r.id=ls.room_id
          JOIN people anchor ON anchor.id=ls.anchor_id
          LEFT JOIN LATERAL (
            SELECT a.*
            FROM makeup_appointments a
            WHERE a.live_session_id=ls.id
              AND a.source_type<>'FEISHU'
              AND a.status IN ('BOOKED','IN_PROGRESS','COMPLETED')
            ORDER BY a.updated_at DESC
            LIMIT 1
          ) appointment ON true
          LEFT JOIN people artist ON artist.id=appointment.makeup_artist_id
          LEFT JOIN LATERAL (
            SELECT assignment.person_id
            FROM room_field_controls assignment
            WHERE assignment.live_session_id=ls.id AND assignment.enabled
            ORDER BY assignment.updated_at DESC
            LIMIT 1
          ) field_control ON true
          LEFT JOIN people control_person ON control_person.id=field_control.person_id
          WHERE (ls.starts_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date
            AND ls.status='SCHEDULED'
            AND ls.source_type='FEISHU'
            AND ($2::uuid IS NULL OR ls.room_id=$2)
            AND ($3::uuid[] IS NULL OR ls.room_id=ANY($3::uuid[]))
          ORDER BY r.name, ls.starts_at
        `,
        [query.date, query.roomId ?? null, allowedRoomIds]
      ),
      this.db.query(
        `
          SELECT s.id, s.person_id, p.display_name, s.raw_shift_value,
                 s.starts_at, s.ends_at, s.parse_status,
                 COALESCE(
                   json_agg(
                     json_build_object(
                       'startsAt', segment.starts_at,
                       'endsAt', segment.ends_at,
                       'bookable', segment.bookable
                     )
                     ORDER BY segment.segment_index
                   ) FILTER (WHERE segment.id IS NOT NULL),
                   '[]'::json
                 ) AS segments
          FROM staff_daily_schedules s
          LEFT JOIN people p ON p.id=s.person_id
          LEFT JOIN staff_schedule_segments segment ON segment.schedule_id=s.id
          WHERE s.role='FIELD_CONTROL' AND s.schedule_date=$1::date
            AND s.cancelled_at IS NULL
            AND s.source_type='FEISHU'
          GROUP BY s.id, p.display_name
          ORDER BY s.starts_at NULLS LAST, p.display_name
        `,
        [query.date]
      )
    ]);
    return {
      date: query.date,
      rooms: rooms.rows,
      sessions: sessions.rows,
      slots: [],
      fieldControls: fieldControls.rows
    };
  }

  @Get('appointment-ledger')
  async appointmentLedger(
    @CurrentUser() user: CurrentUserType,
    @Query() query: AppointmentLedgerQueryDto
  ) {
    const allowedRoomIds = this.canViewAll(user) ? null : user.roomIds;
    return (
      await this.db.query(
        `
          SELECT a.id, a.appointment_no, a.created_at, a.status,
                 subject.display_name AS anchor_name,
                 a.subject_type,
                 artist.display_name AS makeup_artist_name,
                 requester.display_name AS requester_name,
                 a.original_requirement, a.planned_start_at, a.planned_end_at,
                 a.actual_start_at, a.actual_end_at, a.exception_type,
                 a.exception_note, ls.starts_at AS live_starts_at,
                 COALESCE(r.name, a.location) AS room_name,
                 a.source_type, a.last_synced_at
          FROM makeup_appointments a
          JOIN people subject ON subject.id=a.subject_person_id
          JOIN people artist ON artist.id=a.makeup_artist_id
          JOIN people requester ON requester.id=a.requester_id
          LEFT JOIN live_sessions ls ON ls.id=a.live_session_id
          LEFT JOIN rooms r ON r.id=a.room_id
          WHERE ($1::date IS NULL OR a.makeup_date=$1::date)
            AND a.source_type<>'FEISHU'
            AND ($2::uuid[] IS NULL OR a.room_id=ANY($2::uuid[]))
          ORDER BY a.planned_start_at DESC
          LIMIT 300
        `,
        [query.date ?? null, allowedRoomIds]
      )
    ).rows;
  }

  private canViewAll(user: CurrentUserType): boolean {
    return user.roles.some((role) =>
      ['ADMIN', 'DEVELOPER', 'LIVE_SUPERVISOR'].includes(role)
    );
  }

  private assertRoomAccess(
    user: CurrentUserType,
    roomId: string | undefined
  ): void {
    if (
      roomId &&
      !this.canViewAll(user) &&
      !user.roomIds.includes(roomId)
    ) {
      throw new ForbiddenException('只能查看自己负责的直播间');
    }
  }
}
