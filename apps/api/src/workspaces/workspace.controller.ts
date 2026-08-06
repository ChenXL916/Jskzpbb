import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  Matches,
  MaxLength,
  MinLength,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested
} from 'class-validator';
import {
  CurrentUser,
  Permissions,
  Roles
} from '../common/auth.decorators';
import { PasswordService } from '../auth/password.service';
import { DatabaseService } from '../database/database.service';

class CreatePersonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeNo?: string;

  @IsOptional()
  @IsString()
  @Matches(/^ou_[A-Za-z0-9_-]+$/, {
    message: '飞书 Open ID 格式不正确，应以 ou_ 开头'
  })
  feishuOpenId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: '至少选择一个岗位' })
  @IsIn(
    [
      'ANCHOR',
      'TALENT',
      'DIRECTOR',
      'MAKEUP_ARTIST',
      'FIELD_CONTROL',
      'LIVE_SUPERVISOR',
      'ADMIN',
      'DEVELOPER'
    ],
    { each: true }
  )
  roles!: string[];
}

class UpdatePersonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeNo?: string;

  @IsOptional()
  @IsString()
  @Matches(/^ou_[A-Za-z0-9_-]+$/, {
    message: '飞书 Open ID 格式不正确，应以 ou_ 开头'
  })
  feishuOpenId?: string;
}

class UpdatePermissionsDto {
  @IsBoolean()
  loginAllowed!: boolean;

  @IsBoolean()
  bookingAllowed!: boolean;

  @IsArray()
  @IsIn(
    [
      'ANCHOR',
      'TALENT',
      'DIRECTOR',
      'MAKEUP_ARTIST',
      'FIELD_CONTROL',
      'LIVE_SUPERVISOR',
      'ADMIN',
      'DEVELOPER'
    ],
    { each: true }
  )
  roles!: string[];

  @IsArray()
  @IsUUID('4', { each: true })
  roomIds!: string[];
}

class UpdateLocalAccountDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,64}$/, {
    message: '账号只能使用字母、数字、点、下划线或短横线'
  })
  username!: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: '密码至少需要8位' })
  @MaxLength(128, { message: '密码不能超过128位' })
  password?: string;
}

class CreateShiftTemplateDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  startTime?: string;

  @IsOptional()
  @IsString()
  endTime?: string;

  @IsOptional()
  durationMinutes?: number;

  @IsBoolean()
  crossesMidnight!: boolean;

  @IsBoolean()
  bookable!: boolean;

  @IsBoolean()
  confirmationRequired!: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShiftSegmentDto)
  segments?: ShiftSegmentDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}

class ShiftSegmentDto {
  @IsString()
  startTime!: string;

  @IsString()
  endTime!: string;
}

interface CreatedPersonRow extends Record<string, unknown> {
  id: string;
}

interface UpdatedPersonRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  employee_no: string | null;
  feishu_open_id: string | null;
}

interface ShiftTemplateRow extends Record<string, unknown> {
  id: string;
}

@Controller('me')
export class MeController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  profile(@CurrentUser() user: CurrentUserType) {
    return user;
  }

  @Get('live-sessions')
  async liveSessions(@CurrentUser() user: CurrentUserType) {
    const canViewAll = user.roles.some((role) =>
      ['ADMIN', 'DEVELOPER', 'LIVE_SUPERVISOR'].includes(role)
    );
    const isFieldControl = user.roles.includes('FIELD_CONTROL') && !canViewAll;
    return (
      await this.db.query(
        `
          SELECT ls.id, ls.starts_at, ls.ends_at, ls.makeup_required, ls.status,
                 r.id AS room_id, r.name AS room_name,
                 anchor.display_name AS anchor_name,
                 a.status AS appointment_status, a.id AS appointment_id,
                 artist.display_name AS makeup_artist_name,
                 a.planned_start_at, a.planned_end_at
          FROM live_sessions ls
          JOIN rooms r ON r.id=ls.room_id
          JOIN people anchor ON anchor.id=ls.anchor_id
          LEFT JOIN LATERAL (
            SELECT appointment.*
            FROM makeup_appointments appointment
            WHERE appointment.live_session_id=ls.id
              AND appointment.source_type<>'FEISHU'
              AND appointment.status IN ('BOOKED','IN_PROGRESS','COMPLETED')
            ORDER BY
              CASE appointment.status
                WHEN 'IN_PROGRESS' THEN 1
                WHEN 'BOOKED' THEN 2
                ELSE 3
              END,
              appointment.updated_at DESC
            LIMIT 1
          ) a ON true
          LEFT JOIN people artist ON artist.id=a.makeup_artist_id
          WHERE ls.ends_at >= now()
            AND ls.status='SCHEDULED'
            AND ls.source_type='FEISHU'
            AND (
              $2::boolean
              OR ($3::boolean AND ls.room_id = ANY($4::uuid[]))
              OR (NOT $2::boolean AND NOT $3::boolean AND ls.anchor_id=$1)
            )
          ORDER BY ls.starts_at
          LIMIT 120
        `,
        [user.personId, canViewAll, isFieldControl, user.roomIds]
      )
    ).rows;
  }

  @Get('appointments')
  async appointments(@CurrentUser() user: CurrentUserType) {
    return (
      await this.db.query(
        `
          SELECT a.*, artist.display_name AS makeup_artist_name,
                 subject.display_name AS subject_name,
                 COALESCE(r.name, a.location) AS room_name,
                 ls.starts_at AS live_starts_at
          FROM makeup_appointments a
          JOIN people artist ON artist.id=a.makeup_artist_id
          JOIN people subject ON subject.id=a.subject_person_id
          LEFT JOIN rooms r ON r.id=a.room_id
          LEFT JOIN live_sessions ls ON ls.id=a.live_session_id
          WHERE (a.subject_person_id=$1 OR a.requester_id=$1)
            AND a.source_type<>'FEISHU'
          ORDER BY a.planned_start_at DESC LIMIT 100
        `,
        [user.personId]
      )
    ).rows;
  }

  @Get('today')
  async today(@CurrentUser() user: CurrentUserType) {
    const sessions = await this.liveSessions(user);
    const nextBookable = (
      sessions as Array<{ starts_at: string | Date }>
    ).find(
      (session) =>
        new Date(session.starts_at).getTime() > Date.now() + 60 * 60_000
    );
    return {
      user,
      nextLiveSession: nextBookable ?? sessions[0] ?? null,
      sessions,
      serverTime: new Date().toISOString()
    };
  }

  @Get('schedule')
  @Roles(
    'ANCHOR',
    'MAKEUP_ARTIST',
    'FIELD_CONTROL',
    'LIVE_SUPERVISOR',
    'ADMIN',
    'DEVELOPER'
  )
  async schedule(
    @CurrentUser() user: CurrentUserType,
    @Query('month') requestedMonth?: string
  ) {
    const currentMonth = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit'
    })
      .format(new Date())
      .slice(0, 7);
    const month = requestedMonth ?? currentMonth;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new BadRequestException('月份格式应为 YYYY-MM');
    }
    const [year, monthNumber] = month.split('-').map(Number);
    const start = `${month}-01`;
    const next =
      monthNumber === 12
        ? `${year! + 1}-01-01`
        : `${year}-${String(monthNumber! + 1).padStart(2, '0')}-01`;
    const personalRoles = user.roles.filter((role) =>
      ['ANCHOR', 'MAKEUP_ARTIST', 'FIELD_CONTROL'].includes(role)
    );

    const [shifts, liveSessions, appointments] = await Promise.all([
      this.db.query(
        `
          SELECT s.id, s.role::text, s.schedule_date::text,
                 s.raw_shift_value, s.starts_at, s.ends_at,
                 s.is_rest, s.is_leave, s.parse_status, s.notes
          FROM staff_daily_schedules s
          WHERE s.person_id=$1
            AND s.schedule_date >= $2::date
            AND s.schedule_date < $3::date
            AND s.cancelled_at IS NULL
            AND s.source_type='FEISHU'
            AND s.role::text=ANY($4::text[])
          ORDER BY s.schedule_date, s.starts_at NULLS LAST
        `,
        [user.personId, start, next, personalRoles]
      ),
      this.db.query(
        `
          SELECT DISTINCT ls.id, ls.starts_at, ls.ends_at, ls.status,
                 ls.schedule_type, r.id AS room_id, r.name AS room_name,
                 anchor.display_name AS anchor_name,
                 CASE
                   WHEN ls.anchor_id=$1 THEN 'ANCHOR'
                   ELSE 'FIELD_CONTROL'
                 END AS assignment_role
          FROM live_sessions ls
          JOIN rooms r ON r.id=ls.room_id
          JOIN people anchor ON anchor.id=ls.anchor_id
          LEFT JOIN room_field_controls assignment
            ON assignment.live_session_id=ls.id
           AND assignment.person_id=$1
           AND assignment.enabled
          WHERE ls.starts_at >= $2::date
            AND ls.starts_at < $3::date
            AND ls.status='SCHEDULED'
            AND ls.cancelled_at IS NULL
            AND ls.source_type='FEISHU'
            AND (
              ('ANCHOR'=ANY($4::text[]) AND ls.anchor_id=$1)
              OR
              ('FIELD_CONTROL'=ANY($4::text[]) AND assignment.person_id=$1)
            )
          ORDER BY ls.starts_at
        `,
        [user.personId, start, next, personalRoles]
      ),
      this.db.query(
        `
          SELECT a.id, a.appointment_no, a.status, a.subject_type,
                 a.planned_start_at, a.planned_end_at,
                 COALESCE(r.name, a.location) AS location,
                 subject.display_name AS subject_name,
                 artist.display_name AS makeup_artist_name
          FROM makeup_appointments a
          JOIN people subject ON subject.id=a.subject_person_id
          JOIN people artist ON artist.id=a.makeup_artist_id
          LEFT JOIN rooms r ON r.id=a.room_id
          WHERE a.planned_start_at >= $2::date
            AND a.planned_start_at < $3::date
            AND a.source_type<>'FEISHU'
            AND (
              ('MAKEUP_ARTIST'=ANY($4::text[]) AND a.makeup_artist_id=$1)
              OR
              ('ANCHOR'=ANY($4::text[]) AND a.subject_person_id=$1)
            )
          ORDER BY a.planned_start_at
        `,
        [user.personId, start, next, personalRoles]
      )
    ]);

    return {
      month,
      person: {
        id: user.personId,
        displayName: user.displayName
      },
      roles: personalRoles,
      shifts: shifts.rows,
      liveSessions: liveSessions.rows,
      appointments: appointments.rows
    };
  }

  @Get('rooms')
  async rooms(@CurrentUser() user: CurrentUserType) {
    if (
      user.roles.some((role) =>
        ['ADMIN', 'DEVELOPER', 'LIVE_SUPERVISOR'].includes(role)
      )
    ) {
      return (await this.db.query('SELECT id, name FROM rooms WHERE enabled ORDER BY name'))
        .rows;
    }
    return (
      await this.db.query(
        'SELECT id, name FROM rooms WHERE enabled AND id = ANY($1::uuid[]) ORDER BY name',
        [user.roomIds]
      )
    ).rows;
  }
}

@Controller('makeup-artists')
export class MakeupArtistPublicController {
  constructor(private readonly db: DatabaseService) {}

  @Get('availability')
  @Roles(
    'ANCHOR',
    'TALENT',
    'DIRECTOR',
    'FIELD_CONTROL',
    'LIVE_SUPERVISOR',
    'ADMIN',
    'DEVELOPER'
  )
  async availability() {
    return (
      await this.db.query(
        `
          SELECT p.id, p.display_name,
            CASE
              WHEN current_task.id IS NOT NULL THEN 'IN_PROGRESS'
              WHEN current_booking.id IS NOT NULL THEN 'BOOKED'
              WHEN temporary.status_type = 'LEAVE' THEN 'LEAVE'
              WHEN temporary.status_type = 'BREAK' THEN 'BREAK'
              WHEN temporary.id IS NOT NULL THEN 'UNAVAILABLE'
              WHEN leave_block.id IS NOT NULL THEN 'LEAVE'
              WHEN shift.id IS NULL THEN 'OFF_DUTY'
              WHEN next_task.id IS NOT NULL
                AND next_task.planned_start_at <= now()+interval '60 minutes'
                THEN 'BUSY_SOON'
              ELSE 'AVAILABLE'
            END AS public_status,
            current_task.planned_end_at AS current_task_ends_at,
            next_task.planned_start_at AS next_busy_at,
            COALESCE(current_task.planned_end_at, shift.ends_at) AS status_until
          FROM people p
          JOIN person_roles pr ON pr.person_id=p.id
            AND pr.role='MAKEUP_ARTIST' AND pr.enabled
          LEFT JOIN LATERAL (
            SELECT id, planned_end_at FROM makeup_appointments
            WHERE makeup_artist_id=p.id AND status='IN_PROGRESS'
              AND source_type<>'FEISHU'
            LIMIT 1
          ) current_task ON true
          LEFT JOIN LATERAL (
            SELECT id FROM makeup_appointments
            WHERE makeup_artist_id=p.id AND status='BOOKED'
              AND source_type<>'FEISHU'
              AND planned_start_at <= now() AND planned_end_at > now()
            LIMIT 1
          ) current_booking ON true
          LEFT JOIN LATERAL (
            SELECT id, status_type
            FROM person_temporary_statuses
            WHERE person_id=p.id AND cancelled_at IS NULL
              AND starts_at <= now() AND ends_at > now()
            ORDER BY starts_at DESC LIMIT 1
          ) temporary ON true
          LEFT JOIN LATERAL (
            SELECT id FROM makeup_artist_availability
            WHERE makeup_artist_id=p.id AND NOT bookable
              AND starts_at <= now() AND ends_at > now() LIMIT 1
          ) leave_block ON true
          LEFT JOIN LATERAL (
            SELECT s.id, COALESCE(active_segment.ends_at, s.ends_at) AS ends_at
            FROM staff_daily_schedules s
            LEFT JOIN LATERAL (
              SELECT segment.ends_at
              FROM staff_schedule_segments segment
              WHERE segment.schedule_id=s.id AND segment.bookable
                AND segment.starts_at <= now() AND segment.ends_at > now()
              LIMIT 1
            ) active_segment ON true
            WHERE s.person_id=p.id AND s.role='MAKEUP_ARTIST' AND s.is_bookable
              AND s.source_type='FEISHU'
              AND s.parse_status='SUCCESS' AND s.starts_at <= now() AND s.ends_at > now()
              AND (
                NOT EXISTS (
                  SELECT 1 FROM staff_schedule_segments configured
                  WHERE configured.schedule_id=s.id
                )
                OR active_segment.ends_at IS NOT NULL
              )
            LIMIT 1
          ) shift ON true
          LEFT JOIN LATERAL (
            SELECT id, planned_start_at FROM makeup_appointments
            WHERE makeup_artist_id=p.id AND status='BOOKED'
              AND source_type<>'FEISHU'
              AND planned_start_at > now()
            ORDER BY planned_start_at LIMIT 1
          ) next_task ON true
          WHERE p.archived_at IS NULL AND p.booking_allowed
          ORDER BY p.display_name
        `
      )
    ).rows;
  }

  @Get(':id/public-status')
  @Roles(
    'ANCHOR',
    'TALENT',
    'DIRECTOR',
    'FIELD_CONTROL',
    'LIVE_SUPERVISOR',
    'ADMIN',
    'DEVELOPER'
  )
  async publicStatus(@Param('id') id: string) {
    const rows = (await this.availability()) as Array<Record<string, unknown>>;
    return rows.find((row) => row.id === id) ?? null;
  }
}

@Controller('makeup-artist/tasks')
@Roles('MAKEUP_ARTIST')
export class MakeupArtistTaskController {
  constructor(private readonly db: DatabaseService) {}

  @Get('today')
  async today(@CurrentUser() user: CurrentUserType) {
    return (
      await this.db.query(
        `
          SELECT a.*,
                 COALESCE(anchor.display_name, subject.display_name) AS anchor_name,
                 r.name AS room_name, subject.display_name AS subject_name,
                 ls.starts_at AS live_starts_at
          FROM makeup_appointments a
          JOIN people subject ON subject.id=a.subject_person_id
          LEFT JOIN people anchor ON anchor.id=a.anchor_id
          LEFT JOIN rooms r ON r.id=a.room_id
          LEFT JOIN live_sessions ls ON ls.id=a.live_session_id
          WHERE a.makeup_artist_id=$1
            AND a.source_type<>'FEISHU'
            AND (a.planned_start_at AT TIME ZONE 'Asia/Shanghai')::date =
                (now() AT TIME ZONE 'Asia/Shanghai')::date
            AND a.status IN ('BOOKED','IN_PROGRESS','COMPLETED')
          ORDER BY a.planned_start_at
        `,
        [user.personId]
      )
    ).rows;
  }

}

@Controller('control/rooms')
@Roles('FIELD_CONTROL', 'LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
export class ControlRoomController {
  constructor(private readonly db: DatabaseService) {}

  @Get(':roomId/makeup-board')
  async board(
    @CurrentUser() user: CurrentUserType,
    @Param('roomId') roomId: string
  ) {
    this.assertRoomAccess(user, roomId);
    return (
      await this.db.query(
        `
          SELECT ls.id AS live_session_id, ls.starts_at AS live_starts_at,
                 ls.ends_at AS live_ends_at, anchor.display_name AS anchor_name,
                 a.id AS appointment_id,
                 artist.display_name AS makeup_artist_name,
                 a.planned_start_at, a.planned_end_at, a.status AS appointment_status,
                 active_risk.risk_type AS domain_risk_type,
                 active_risk.severity AS risk_severity,
                 CASE
                   WHEN NOT ls.makeup_required THEN 'NO_MAKEUP_REQUIRED'
                   WHEN active_risk.risk_type='UNBOOKED_BEFORE_LIVE'
                     THEN 'RISK_UNBOOKED'
                   WHEN active_risk.risk_type='MAKEUP_INCOMPLETE_BEFORE_LIVE'
                     THEN 'RISK_OVERTIME'
                   WHEN a.status='COMPLETED' THEN 'READY'
                   ELSE 'NORMAL'
                 END AS risk
          FROM live_sessions ls
          JOIN people anchor ON anchor.id=ls.anchor_id
          LEFT JOIN makeup_appointments a ON a.live_session_id=ls.id
            AND a.source_type<>'FEISHU'
            AND a.status IN ('BOOKED','IN_PROGRESS','COMPLETED')
          LEFT JOIN people artist ON artist.id=a.makeup_artist_id
          LEFT JOIN LATERAL (
            SELECT risk.risk_type, risk.severity
            FROM risk_items risk
            WHERE risk.live_session_id=ls.id
              AND risk.status IN ('OPEN','ACKNOWLEDGED')
            ORDER BY
              CASE risk.severity
                WHEN 'URGENT' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3
              END,
              risk.occurred_at DESC
            LIMIT 1
          ) active_risk ON true
          WHERE ls.room_id=$1
            AND ls.status='SCHEDULED'
            AND ls.source_type='FEISHU'
            AND (ls.starts_at AT TIME ZONE 'Asia/Shanghai')::date =
                (now() AT TIME ZONE 'Asia/Shanghai')::date
          ORDER BY ls.starts_at
        `,
        [roomId]
      )
    ).rows;
  }

  @Get(':roomId/risks')
  async risks(
    @CurrentUser() user: CurrentUserType,
    @Param('roomId') roomId: string
  ) {
    const rows = (await this.board(user, roomId)) as Array<Record<string, unknown>>;
    return rows.filter((row) => String(row.risk).startsWith('RISK_'));
  }

  private assertRoomAccess(user: CurrentUserType, roomId: string): void {
    if (
      !user.roles.some((role) =>
        ['ADMIN', 'DEVELOPER', 'LIVE_SUPERVISOR'].includes(role)
      ) &&
      !user.roomIds.includes(roomId)
    ) {
      throw new ForbiddenException('场控只能查看自己负责的直播间');
    }
  }
}

@Controller('admin')
@Roles('ADMIN', 'DEVELOPER')
export class AdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService
  ) {}

  @Get('people')
  @Permissions('people.manage')
  async people() {
    return (
      await this.db.query(
        `
          SELECT p.*,
                 max(u.last_login_at) AS last_login_at,
                 max(u.username) AS username,
                 COALESCE(bool_or(u.password_hash IS NOT NULL), false)
                   AS has_local_password,
                 COALESCE(
                   array_agg(DISTINCT pr.role::text) FILTER (WHERE pr.enabled),
                   ARRAY[]::text[]
                 ) AS roles,
                 COALESCE(array_agg(DISTINCT uds.scope_id::text)
                   FILTER (WHERE uds.scope_type='ROOM' AND uds.can_view), '{}') AS room_ids
          FROM people p
          LEFT JOIN person_roles pr ON pr.person_id=p.id
          LEFT JOIN users u ON u.person_id=p.id
          LEFT JOIN user_data_scopes uds ON uds.user_id=u.id
          GROUP BY p.id ORDER BY p.display_name
        `
      )
    ).rows;
  }

  @Patch('people/:id/account')
  @Permissions('people.manage')
  async localAccount(
    @CurrentUser() actor: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: UpdateLocalAccountDto
  ) {
    const normalizedUsername = dto.username.trim().toLowerCase();
    const passwordHash = dto.password
      ? await this.passwords.hash(dto.password)
      : null;
    return this.db.transaction(async (client) => {
      const person = await client.query<{ id: string }>(
        'SELECT id FROM people WHERE id=$1 FOR UPDATE',
        [id]
      );
      if (!person.rows[0]) {
        throw new BadRequestException('人员不存在');
      }
      const duplicate = await client.query<{ id: string }>(
        `
          SELECT id FROM users
          WHERE lower(username)=$1 AND person_id<>$2
        `,
        [normalizedUsername, id]
      );
      if (duplicate.rows[0]) {
        throw new ConflictException('该系统账号已被使用');
      }
      const before = await client.query<{
        id: string;
        username: string | null;
        has_password: boolean;
      }>(
        `
          SELECT id, username, password_hash IS NOT NULL AS has_password
          FROM users WHERE person_id=$1
        `,
        [id]
      );
      if (!before.rows[0]?.has_password && !passwordHash) {
        throw new BadRequestException('首次创建系统账号时必须设置密码');
      }

      const user = await client.query<{ id: string }>(
        `
          INSERT INTO users(
            person_id, username, password_hash, auth_source,
            password_changed_at
          )
          VALUES ($1,$2,$3,'LOCAL',CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
          ON CONFLICT (person_id) DO UPDATE SET
            username=EXCLUDED.username,
            password_hash=COALESCE(EXCLUDED.password_hash, users.password_hash),
            auth_source='LOCAL',
            password_changed_at=CASE
              WHEN EXCLUDED.password_hash IS NULL THEN users.password_changed_at
              ELSE now()
            END,
            failed_login_count=0,
            last_failed_login_at=NULL,
            locked_until=NULL,
            updated_at=now()
          RETURNING id
        `,
        [id, normalizedUsername, passwordHash]
      );
      await client.query(
        `
          INSERT INTO user_role_bindings(user_id, role_id, enabled, assigned_by)
          SELECT $1, role.id, true, $2
          FROM person_roles legacy
          JOIN roles role ON role.code=legacy.role::text
          WHERE legacy.person_id=$3 AND legacy.enabled
          ON CONFLICT (user_id, role_id) DO UPDATE SET
            enabled=true, assigned_by=$2, updated_at=now()
        `,
        [user.rows[0]!.id, actor.personId, id]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id,
            before_data, after_data
          ) VALUES ($1,'UPDATE_LOCAL_ACCOUNT','USER',$2,$3,$4)
        `,
        [
          actor.personId,
          user.rows[0]!.id,
          JSON.stringify(before.rows[0] ?? null),
          JSON.stringify({
            username: normalizedUsername,
            passwordChanged: Boolean(passwordHash)
          })
        ]
      );
      return {
        username: normalizedUsername,
        hasLocalPassword: true
      };
    });
  }

  @Post('people')
  @Permissions('people.manage')
  async createPerson(
    @CurrentUser() actor: CurrentUserType,
    @Body() dto: CreatePersonDto
  ): Promise<CreatedPersonRow> {
    return this.db.transaction(async (client) => {
      const displayName = dto.displayName.trim();
      const employeeNo = dto.employeeNo?.trim() || null;
      const feishuOpenId = dto.feishuOpenId?.trim() || null;
      const duplicate = await client.query<{ id: string }>(
        `
          SELECT id FROM people
          WHERE ($1::text IS NOT NULL AND employee_no=$1)
             OR ($2::text IS NOT NULL AND feishu_open_id=$2)
          LIMIT 1
        `,
        [employeeNo, feishuOpenId]
      );
      if (duplicate.rows[0]) {
        throw new ConflictException('员工编号或飞书 Open ID 已绑定其他人员');
      }
      const person = await client.query<CreatedPersonRow>(
        `
          INSERT INTO people(
            display_name, employee_no, feishu_open_id,
            login_allowed, booking_allowed
          )
          VALUES ($1,$2,$3,false,$4) RETURNING *
        `,
        [
          displayName,
          employeeNo,
          feishuOpenId,
          dto.roles.some((role) =>
            ['ANCHOR', 'TALENT', 'DIRECTOR', 'MAKEUP_ARTIST', 'FIELD_CONTROL'].includes(
              role
            )
          )
        ]
      );
      for (const role of dto.roles) {
        await client.query(
          'INSERT INTO person_roles(person_id, role) VALUES ($1,$2)',
          [person.rows[0]!.id, role]
        );
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, after_data
          ) VALUES ($1,'CREATE_PERSON','PERSON',$2,$3)
        `,
        [
          actor.personId,
          person.rows[0]!.id,
          JSON.stringify({
            displayName,
            employeeNo,
            feishuOpenId,
            roles: dto.roles
          })
        ]
      );
      return person.rows[0]!;
    });
  }

  @Patch('people/:id')
  @Permissions('people.manage')
  async updatePerson(
    @CurrentUser() actor: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: UpdatePersonDto
  ): Promise<UpdatedPersonRow> {
    return this.db.transaction(async (client) => {
      const before = await client.query(
        `
          SELECT display_name, employee_no, feishu_open_id
          FROM people WHERE id=$1 FOR UPDATE
        `,
        [id]
      );
      if (!before.rows[0]) throw new BadRequestException('人员不存在');
      const displayName = dto.displayName.trim();
      const employeeNo = dto.employeeNo?.trim() || null;
      const feishuOpenId = dto.feishuOpenId?.trim() || null;
      const duplicate = await client.query<{ id: string }>(
        `
          SELECT id FROM people
          WHERE id<>$1 AND (
            ($2::text IS NOT NULL AND employee_no=$2)
            OR ($3::text IS NOT NULL AND feishu_open_id=$3)
          )
          LIMIT 1
        `,
        [id, employeeNo, feishuOpenId]
      );
      if (duplicate.rows[0]) {
        throw new ConflictException('员工编号或飞书 Open ID 已绑定其他人员');
      }
      const updated = await client.query<UpdatedPersonRow>(
        `
          UPDATE people
          SET display_name=$2, employee_no=$3, feishu_open_id=$4,
              updated_at=now()
          WHERE id=$1
          RETURNING id, display_name, employee_no, feishu_open_id
        `,
        [id, displayName, employeeNo, feishuOpenId]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id,
            before_data, after_data
          ) VALUES ($1,'UPDATE_PERSON','PERSON',$2,$3,$4)
        `,
        [
          actor.personId,
          id,
          JSON.stringify(before.rows[0]),
          JSON.stringify(updated.rows[0])
        ]
      );
      return updated.rows[0]!;
    });
  }

  @Post('people/:id/archive')
  @Permissions('people.manage')
  async archivePerson(
    @CurrentUser() actor: CurrentUserType,
    @Param('id') id: string
  ) {
    if (id === actor.personId) {
      throw new BadRequestException('不能归档当前登录账号');
    }
    return this.db.transaction(async (client) => {
      const person = await client.query(
        `SELECT id, display_name, archived_at FROM people WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (!person.rows[0]) throw new BadRequestException('人员不存在');
      await client.query(
        `
          UPDATE people
          SET archived_at=COALESCE(archived_at,now()),
              employment_status='ARCHIVED', login_allowed=false,
              booking_allowed=false, updated_at=now()
          WHERE id=$1
        `,
        [id]
      );
      await client.query(
        `UPDATE users SET disabled_at=now(), updated_at=now() WHERE person_id=$1`,
        [id]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, before_data
          ) VALUES ($1,'ARCHIVE_PERSON','PERSON',$2,$3)
        `,
        [actor.personId, id, JSON.stringify(person.rows[0])]
      );
      return { ok: true, archived: true };
    });
  }

  @Post('people/:id/restore')
  @Permissions('people.manage')
  async restorePerson(
    @CurrentUser() actor: CurrentUserType,
    @Param('id') id: string
  ) {
    return this.db.transaction(async (client) => {
      const person = await client.query(
        `SELECT id, display_name, archived_at FROM people WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (!person.rows[0]) throw new BadRequestException('人员不存在');
      await client.query(
        `
          UPDATE people
          SET archived_at=NULL, employment_status='ACTIVE', updated_at=now()
          WHERE id=$1
        `,
        [id]
      );
      await client.query(
        `UPDATE users SET disabled_at=NULL, updated_at=now() WHERE person_id=$1`,
        [id]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, before_data
          ) VALUES ($1,'RESTORE_PERSON','PERSON',$2,$3)
        `,
        [actor.personId, id, JSON.stringify(person.rows[0])]
      );
      return { ok: true, archived: false };
    });
  }

  @Patch('people/:id/permissions')
  @Permissions('people.manage')
  async permissions(
    @CurrentUser() actor: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: UpdatePermissionsDto
  ) {
    return this.db.transaction(async (client) => {
      const before = await client.query(
        `
          SELECT p.login_allowed, p.booking_allowed,
                 ARRAY(
                   SELECT role::text FROM person_roles
                   WHERE person_id=p.id AND enabled
                   ORDER BY role::text
                 ) AS roles
          FROM people p WHERE p.id=$1
          FOR UPDATE
        `,
        [id]
      );
      await client.query(
        'UPDATE people SET login_allowed=$2, booking_allowed=$3 WHERE id=$1',
        [id, dto.loginAllowed, dto.bookingAllowed]
      );
      await client.query('UPDATE person_roles SET enabled=false WHERE person_id=$1', [
        id
      ]);
      for (const role of dto.roles) {
        await client.query(
          `
            INSERT INTO person_roles(person_id, role, enabled)
            VALUES ($1,$2,true)
            ON CONFLICT (person_id, role) DO UPDATE SET enabled=true, updated_at=now()
          `,
          [id, role]
        );
      }
      const user = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE person_id=$1',
        [id]
      );
      if (user.rows[0]) {
        await client.query(
          'UPDATE user_role_bindings SET enabled=false WHERE user_id=$1',
          [user.rows[0].id]
        );
        for (const role of dto.roles) {
          await client.query(
            `
              INSERT INTO user_role_bindings(user_id, role_id, enabled, assigned_by)
              SELECT $1, id, true, $3 FROM roles WHERE code=$2
              ON CONFLICT (user_id, role_id) DO UPDATE SET
                enabled=true, assigned_by=$3, updated_at=now()
            `,
            [user.rows[0].id, role, actor.personId]
          );
        }
        await client.query(
          `DELETE FROM user_data_scopes WHERE user_id=$1 AND scope_type='ROOM'`,
          [user.rows[0].id]
        );
        for (const roomId of dto.roomIds) {
          await client.query(
            `
              INSERT INTO user_data_scopes(user_id, scope_type, scope_id)
              VALUES ($1,'ROOM',$2)
            `,
            [user.rows[0].id, roomId]
          );
        }
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id,
            before_data, after_data
          ) VALUES ($1,'UPDATE_PERSON_PERMISSIONS','PERSON',$2,$3,$4)
        `,
        [
          actor.personId,
          id,
          JSON.stringify(before.rows[0] ?? null),
          JSON.stringify(dto)
        ]
      );
      return { ok: true };
    });
  }

  @Get('shift-templates')
  @Permissions('shift.manage')
  async shiftTemplates() {
    return (
      await this.db.query(
        `
          SELECT st.*,
                 COALESCE(
                   array_agg(sta.alias ORDER BY sta.alias)
                     FILTER (WHERE sta.id IS NOT NULL),
                   ARRAY[]::text[]
                 ) AS aliases
          FROM shift_templates st
          LEFT JOIN shift_template_aliases sta ON sta.shift_template_id=st.id
          GROUP BY st.id
          ORDER BY st.name
        `
      )
    ).rows;
  }

  @Post('shift-templates')
  @Permissions('shift.manage')
  async createShiftTemplate(
    @CurrentUser() actor: CurrentUserType,
    @Body() dto: CreateShiftTemplateDto
  ) {
    return this.db.transaction(async (client) => {
      const created = (
        await client.query<ShiftTemplateRow>(
        `
          INSERT INTO shift_templates(
            name,start_time,end_time,duration_minutes,crosses_midnight,
            bookable,confirmation_required,segments
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          RETURNING *
        `,
        [
          dto.name,
          dto.startTime ?? null,
          dto.endTime ?? null,
          dto.durationMinutes ?? null,
          dto.crossesMidnight,
          dto.bookable,
          dto.confirmationRequired,
          JSON.stringify(dto.segments ?? [])
        ]
      )
      ).rows[0];
      if (!created) {
        throw new ForbiddenException('班次模板创建失败');
      }
      for (const alias of dto.aliases ?? []) {
        await client.query(
          `
            INSERT INTO shift_template_aliases(
              shift_template_id, alias, normalized_alias
            )
            VALUES ($1,$2,lower(regexp_replace($2, '[[:space:]]+', '', 'g')))
            ON CONFLICT (normalized_alias) DO UPDATE SET
              shift_template_id=EXCLUDED.shift_template_id,
              alias=EXCLUDED.alias,
              enabled=true,
              updated_at=now()
          `,
          [created.id, alias]
        );
      }
      await client.query(
        `
          INSERT INTO operation_logs(actor_id,action,resource_type,resource_id,after_data)
          VALUES ($1,'CREATE_SHIFT_TEMPLATE','SHIFT_TEMPLATE',$2,$3)
        `,
        [actor.personId, created.id, JSON.stringify(dto)]
      );
      return created;
    });
  }

  @Patch('shift-templates/:id')
  @Permissions('shift.manage')
  async updateShiftTemplate(
    @CurrentUser() actor: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: CreateShiftTemplateDto
  ) {
    return this.db.transaction(async (client) => {
      const before = await client.query<ShiftTemplateRow>(
        'SELECT * FROM shift_templates WHERE id=$1 FOR UPDATE',
        [id]
      );
      const updated = (
        await client.query<ShiftTemplateRow>(
          `
            UPDATE shift_templates SET
              name=$2,start_time=$3,end_time=$4,duration_minutes=$5,
              crosses_midnight=$6,bookable=$7,confirmation_required=$8,
              segments=$9,updated_at=now()
            WHERE id=$1 RETURNING *
          `,
          [
            id,
            dto.name,
            dto.startTime ?? null,
            dto.endTime ?? null,
            dto.durationMinutes ?? null,
            dto.crossesMidnight,
            dto.bookable,
            dto.confirmationRequired,
            JSON.stringify(dto.segments ?? [])
          ]
        )
      ).rows[0];
      if (!updated) {
        throw new ForbiddenException('班次模板不存在或不可编辑');
      }
      await client.query(
        'DELETE FROM shift_template_aliases WHERE shift_template_id=$1',
        [id]
      );
      for (const alias of dto.aliases ?? []) {
        await client.query(
          `
            INSERT INTO shift_template_aliases(
              shift_template_id, alias, normalized_alias
            )
            VALUES ($1,$2,lower(regexp_replace($2, '[[:space:]]+', '', 'g')))
            ON CONFLICT (normalized_alias) DO UPDATE SET
              shift_template_id=EXCLUDED.shift_template_id,
              alias=EXCLUDED.alias,
              enabled=true,
              updated_at=now()
          `,
          [id, alias]
        );
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id,action,resource_type,resource_id,before_data,after_data
          ) VALUES ($1,'UPDATE_SHIFT_TEMPLATE','SHIFT_TEMPLATE',$2,$3,$4)
        `,
        [
          actor.personId,
          id,
          JSON.stringify(before.rows[0] ?? null),
          JSON.stringify(dto)
        ]
      );
      return updated;
    });
  }

  @Get('rooms')
  @Permissions('people.manage')
  async rooms() {
    return (await this.db.query('SELECT * FROM rooms ORDER BY name')).rows;
  }
}
