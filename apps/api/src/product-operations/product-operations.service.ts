import {
  BadRequestException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { CurrentUser } from '@jishi/contracts';
import { DatabaseService } from '../database/database.service';
import {
  PaginationQueryDto,
  TemporaryStatusDto
} from './product-operations.dto';

interface SettingRow extends Record<string, unknown> {
  key: string;
  value: unknown;
  value_type: string;
  description: string | null;
}

interface EntityRow extends Record<string, unknown> {
  id: string;
}

@Injectable()
export class ProductOperationsService {
  constructor(private readonly db: DatabaseService) {}

  async roles() {
    const result = await this.db.query(
      `
        SELECT r.id, r.code, r.name, r.description, r.enabled, r.sort_order,
               COALESCE(
                 jsonb_agg(
                   jsonb_build_object(
                     'id', p.id,
                     'code', p.code,
                     'name', p.name,
                     'module', p.module
                   )
                   ORDER BY p.module, p.code
                 ) FILTER (WHERE p.id IS NOT NULL AND rp.granted),
                 '[]'::jsonb
               ) AS permissions
        FROM roles r
        LEFT JOIN role_permissions rp ON rp.role_id=r.id
        LEFT JOIN permissions p ON p.id=rp.permission_id
        GROUP BY r.id
        ORDER BY r.sort_order, r.name
      `
    );
    return result.rows;
  }

  async permissions() {
    const result = await this.db.query(
      `
        SELECT id, code, name, module, description
        FROM permissions
        ORDER BY module, code
      `
    );
    return result.rows;
  }

  async bookingRules() {
    const result = await this.db.query<{
      key: string;
      value: unknown;
      value_type: string;
      description: string | null;
    }>(
      `
        SELECT key, value, value_type, description
        FROM system_settings
        WHERE category IN ('BOOKING', 'RISK')
        ORDER BY category, key
      `
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        row.key,
        {
          value: row.value,
          valueType: row.value_type,
          description: row.description
        }
      ])
    );
  }

  async updateBookingRules(
    user: CurrentUser,
    settings: Record<string, unknown>
  ) {
    const entries = Object.entries(settings);
    if (!entries.length) {
      throw new BadRequestException('至少需要提交一项预约规则');
    }
    return this.db.transaction<Record<string, {
      value: unknown;
      valueType: string;
      description: string | null;
    }>>(async (client) => {
      const allowed = await client.query<{
        key: string;
        value: unknown;
      }>(
        `
          SELECT key, value
          FROM system_settings
          WHERE key=ANY($1::text[]) AND category IN ('BOOKING', 'RISK')
            AND editable
          FOR UPDATE
        `,
        [entries.map(([key]) => key)]
      );
      if (allowed.rowCount !== entries.length) {
        throw new BadRequestException('提交内容包含不存在或不可编辑的预约规则');
      }
      const before = Object.fromEntries(
        allowed.rows.map((row) => [row.key, row.value])
      );
      for (const [key, value] of entries) {
        await client.query(
          `
            UPDATE system_settings
            SET value=$2::jsonb, updated_by=$3
            WHERE key=$1
          `,
          [key, JSON.stringify(value), user.personId]
        );
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, before_data, after_data
          ) VALUES ($1,'UPDATE_BOOKING_RULES','SYSTEM_SETTINGS',$2,$3)
        `,
        [user.personId, JSON.stringify(before), JSON.stringify(settings)]
      );
      const updated = await client.query<SettingRow>(
        `
          SELECT key, value, value_type, description
          FROM system_settings
          WHERE category IN ('BOOKING', 'RISK')
          ORDER BY category, key
        `
      );
      return Object.fromEntries(
        updated.rows.map((row) => [
          row.key,
          {
            value: row.value,
            valueType: row.value_type,
            description: row.description
          }
        ])
      );
    });
  }

  async syncJobs(query: PaginationQueryDto) {
    const offset = (query.page - 1) * query.pageSize;
    const values: unknown[] = [query.pageSize, offset];
    const listStatusFilter = query.status
      ? `AND j.status::text=$${values.push(query.status)}`
      : '';
    const countStatusFilter = query.status ? 'AND j.status::text=$1' : '';
    const [items, count] = await Promise.all([
      this.db.query(
        `
          SELECT j.id, j.job_type, j.status, j.started_at, j.finished_at,
                 j.fetched_count, j.created_count, j.updated_count,
                 j.skipped_count, j.failed_count, j.retry_count,
                 j.error_message, mapping.table_name, mapping.table_id,
                 count(job_item.id)::int AS item_count,
                 count(job_item.id) FILTER (
                   WHERE job_item.status='FAILED'
                 )::int AS failed_item_count
          FROM sync_jobs j
          LEFT JOIN feishu_table_mappings mapping
            ON mapping.id=j.table_mapping_id
          LEFT JOIN sync_job_items job_item ON job_item.job_id=j.id
          WHERE true ${listStatusFilter}
          GROUP BY j.id, mapping.id
          ORDER BY j.created_at DESC
          LIMIT $1 OFFSET $2
        `,
        values
      ),
      this.db.query<{ total: number }>(
        `
          SELECT count(*)::int AS total
          FROM sync_jobs j
          WHERE true ${countStatusFilter}
        `,
        query.status ? [query.status] : []
      )
    ]);
    return {
      items: items.rows,
      page: query.page,
      pageSize: query.pageSize,
      total: count.rows[0]?.total ?? 0
    };
  }

  async operationLogs(query: PaginationQueryDto) {
    const offset = (query.page - 1) * query.pageSize;
    const [items, count] = await Promise.all([
      this.db.query(
        `
          SELECT log.id, log.action, log.resource_type, log.resource_id,
                 log.request_id, log.before_data, log.after_data,
                 log.created_at, actor.display_name AS actor_name
          FROM operation_logs log
          LEFT JOIN people actor ON actor.id=log.actor_id
          ORDER BY log.created_at DESC
          LIMIT $1 OFFSET $2
        `,
        [query.pageSize, offset]
      ),
      this.db.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM operation_logs'
      )
    ]);
    return {
      items: items.rows,
      page: query.page,
      pageSize: query.pageSize,
      total: count.rows[0]?.total ?? 0
    };
  }

  async notifications(user: CurrentUser, query: PaginationQueryDto) {
    const offset = (query.page - 1) * query.pageSize;
    const [items, count, unread] = await Promise.all([
      this.db.query(
        `
          SELECT id, event_type, title, body, resource_type, resource_id,
                 severity, read_at, created_at, metadata
          FROM notifications
          WHERE recipient_person_id=$1 AND archived_at IS NULL
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3
        `,
        [user.personId, query.pageSize, offset]
      ),
      this.db.query<{ total: number }>(
        `
          SELECT count(*)::int AS total
          FROM notifications
          WHERE recipient_person_id=$1 AND archived_at IS NULL
        `,
        [user.personId]
      ),
      this.db.query<{ total: number }>(
        `
          SELECT count(*)::int AS total
          FROM notifications
          WHERE recipient_person_id=$1 AND archived_at IS NULL
            AND read_at IS NULL
        `,
        [user.personId]
      )
    ]);
    return {
      items: items.rows,
      page: query.page,
      pageSize: query.pageSize,
      total: count.rows[0]?.total ?? 0,
      unread: unread.rows[0]?.total ?? 0
    };
  }

  async markNotificationRead(user: CurrentUser, id: string) {
    const result = await this.db.query(
      `
        UPDATE notifications
        SET read_at=COALESCE(read_at, now())
        WHERE id=$1 AND recipient_person_id=$2 AND archived_at IS NULL
        RETURNING *
      `,
      [id, user.personId]
    );
    if (!result.rows[0]) throw new NotFoundException('通知不存在');
    return result.rows[0];
  }

  async markAllNotificationsRead(user: CurrentUser) {
    const result = await this.db.query(
      `
        UPDATE notifications
        SET read_at=now()
        WHERE recipient_person_id=$1 AND read_at IS NULL
          AND archived_at IS NULL
      `,
      [user.personId]
    );
    return { updated: result.rowCount ?? 0 };
  }

  async managementDashboard() {
    const [metrics, rooms, risks, sync] = await Promise.all([
      this.db.query(
        `
          SELECT
            (SELECT count(*)::int FROM live_sessions
             WHERE (starts_at AT TIME ZONE 'Asia/Shanghai')::date =
                   (now() AT TIME ZONE 'Asia/Shanghai')::date
               AND status='SCHEDULED'
               AND source_type='FEISHU')
               AS live_session_count,
            (SELECT count(*)::int FROM makeup_appointments
             WHERE makeup_date=(now() AT TIME ZONE 'Asia/Shanghai')::date
               AND status='BOOKED' AND source_type<>'FEISHU') AS booked_count,
            (SELECT count(*)::int FROM makeup_appointments
             WHERE makeup_date=(now() AT TIME ZONE 'Asia/Shanghai')::date
               AND status='IN_PROGRESS' AND source_type<>'FEISHU') AS in_progress_count,
            (SELECT count(*)::int FROM makeup_appointments
             WHERE makeup_date=(now() AT TIME ZONE 'Asia/Shanghai')::date
               AND status='COMPLETED' AND source_type<>'FEISHU') AS completed_count,
            (SELECT count(*)::int FROM risk_items
             WHERE status IN ('OPEN','ACKNOWLEDGED')) AS risk_count,
            (SELECT count(DISTINCT person_id)::int FROM staff_daily_schedules
             WHERE role='MAKEUP_ARTIST' AND parse_status='SUCCESS'
               AND source_type='FEISHU'
               AND is_bookable AND starts_at <= now() AND ends_at > now())
               AS makeup_artist_on_duty_count,
            (SELECT count(DISTINCT person_id)::int FROM staff_daily_schedules
             WHERE role='FIELD_CONTROL' AND parse_status='SUCCESS'
               AND source_type='FEISHU'
               AND starts_at <= now() AND ends_at > now())
               AS field_control_on_duty_count
        `
      ),
      this.db.query(
        `
          SELECT room.id, room.name,
                 count(DISTINCT session.id) FILTER (
                   WHERE session.starts_at <= now() AND session.ends_at > now()
                 )::int AS current_session_count,
                 min(session.starts_at) FILTER (
                   WHERE session.starts_at > now()
                 ) AS next_session_at,
                 count(DISTINCT appointment.id) FILTER (
                   WHERE appointment.status='BOOKED'
                 )::int AS booked_count,
                 count(DISTINCT appointment.id) FILTER (
                   WHERE appointment.status='IN_PROGRESS'
                 )::int AS in_progress_count
          FROM rooms room
          LEFT JOIN live_sessions session ON session.room_id=room.id
            AND (session.starts_at AT TIME ZONE 'Asia/Shanghai')::date =
                (now() AT TIME ZONE 'Asia/Shanghai')::date
            AND session.source_type='FEISHU'
            AND session.status='SCHEDULED' AND session.cancelled_at IS NULL
          LEFT JOIN makeup_appointments appointment
            ON appointment.live_session_id=session.id
            AND appointment.source_type<>'FEISHU'
          WHERE room.enabled
          GROUP BY room.id
          ORDER BY room.name
        `
      ),
      this.openRisks(),
      this.db.query(
        `
          SELECT status, finished_at, error_message
          FROM sync_jobs
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
    ]);
    return {
      metrics: metrics.rows[0],
      rooms: rooms.rows,
      risks,
      latestSync: sync.rows[0] ?? null
    };
  }

  async workload() {
    const result = await this.db.query(
      `
        SELECT person.id, person.display_name,
               count(appointment.id)::int AS task_count,
               count(appointment.id) FILTER (
                 WHERE appointment.status='COMPLETED'
               )::int AS completed_count,
               COALESCE(sum(
                 EXTRACT(EPOCH FROM (
                   appointment.planned_end_at-appointment.planned_start_at
                 ))/60
               ), 0)::int AS planned_minutes,
               min(appointment.planned_start_at) FILTER (
                 WHERE appointment.status='BOOKED'
                   AND appointment.planned_start_at > now()
               ) AS next_task_at
        FROM people person
        JOIN person_roles role ON role.person_id=person.id
          AND role.role='MAKEUP_ARTIST' AND role.enabled
        LEFT JOIN makeup_appointments appointment
          ON appointment.makeup_artist_id=person.id
          AND appointment.makeup_date =
              (now() AT TIME ZONE 'Asia/Shanghai')::date
        WHERE person.archived_at IS NULL
        GROUP BY person.id
        ORDER BY task_count, person.display_name
      `
    );
    return result.rows;
  }

  async openRisks(roomIds?: string[]) {
    const values: unknown[] = [];
    const roomFilter = roomIds?.length
      ? `AND (risk.room_id IS NULL OR risk.room_id=ANY($${values.push(
          roomIds
        )}::uuid[]))`
      : '';
    const result = await this.db.query(
      `
        SELECT risk.*, room.name AS room_name, person.display_name AS person_name,
               owner.display_name AS owner_name
        FROM risk_items risk
        LEFT JOIN rooms room ON room.id=risk.room_id
        LEFT JOIN people person ON person.id=risk.person_id
        LEFT JOIN people owner ON owner.id=risk.owner_id
        WHERE risk.status IN ('OPEN','ACKNOWLEDGED') ${roomFilter}
        ORDER BY
          CASE risk.severity
            WHEN 'URGENT' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3
          END,
          risk.due_at NULLS LAST,
          risk.occurred_at DESC
        LIMIT 100
      `,
      values
    );
    return result.rows;
  }

  async resolveRisk(
    user: CurrentUser,
    id: string,
    note?: string
  ) {
    const elevated = user.roles.some((role) =>
      ['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER'].includes(role)
    );
    return this.db.transaction<EntityRow>(async (client) => {
      const result = await client.query<EntityRow>(
        `
          UPDATE risk_items
          SET status='RESOLVED', resolved_by=$2, resolved_at=now(),
              resolution_note=$3
          WHERE id=$1 AND status IN ('OPEN','ACKNOWLEDGED')
            AND (
              $4::boolean
              OR room_id=ANY($5::uuid[])
            )
          RETURNING *
        `,
        [id, user.personId, note ?? null, elevated, user.roomIds]
      );
      if (!result.rows[0]) {
        throw new NotFoundException('风险不存在、已处理或不在当前数据范围内');
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, after_data
          ) VALUES ($1,'RESOLVE_RISK','RISK',$2,$3)
        `,
        [user.personId, id, JSON.stringify(result.rows[0])]
      );
      return result.rows[0];
    });
  }

  async makeupArtistDashboard(user: CurrentUser) {
    const result = await this.db.query<Record<string, unknown>>(
      `
        SELECT
          (SELECT jsonb_build_object(
            'startsAt', schedule.starts_at,
            'endsAt', schedule.ends_at,
            'rawShiftValue', schedule.raw_shift_value
          )
          FROM staff_daily_schedules schedule
          WHERE schedule.person_id=$1 AND schedule.role='MAKEUP_ARTIST'
            AND schedule.source_type='FEISHU'
            AND schedule.schedule_date =
                (now() AT TIME ZONE 'Asia/Shanghai')::date
            AND schedule.parse_status='SUCCESS'
          ORDER BY schedule.starts_at NULLS LAST
          LIMIT 1) AS shift,
          (SELECT jsonb_build_object(
            'statusType', temporary.status_type,
            'startsAt', temporary.starts_at,
            'endsAt', temporary.ends_at,
            'reason', temporary.reason
          )
          FROM person_temporary_statuses temporary
          WHERE temporary.person_id=$1 AND temporary.cancelled_at IS NULL
            AND temporary.starts_at <= now() AND temporary.ends_at > now()
          ORDER BY temporary.starts_at DESC
          LIMIT 1) AS temporary_status,
          count(appointment.id)::int AS task_count,
          count(appointment.id) FILTER (
            WHERE appointment.status='COMPLETED'
          )::int AS completed_count,
          count(appointment.id) FILTER (
            WHERE appointment.status='IN_PROGRESS'
          )::int AS in_progress_count,
          min(appointment.planned_start_at) FILTER (
            WHERE appointment.status='BOOKED'
              AND appointment.planned_start_at > now()
          ) AS next_task_at
        FROM people person
        LEFT JOIN makeup_appointments appointment
          ON appointment.makeup_artist_id=person.id
          AND appointment.makeup_date =
              (now() AT TIME ZONE 'Asia/Shanghai')::date
        WHERE person.id=$1
        GROUP BY person.id
      `,
      [user.personId]
    );
    if (!result.rows[0]) throw new NotFoundException('化妆师人员资料不存在');
    return result.rows[0];
  }

  async setTemporaryStatus(
    user: CurrentUser,
    dto: TemporaryStatusDto
  ) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt || endsAt <= new Date()) {
      throw new BadRequestException('临时状态结束时间必须晚于开始时间和当前时间');
    }
    return this.db.transaction<EntityRow>(async (client) => {
      const result = await client.query<EntityRow>(
        `
          INSERT INTO person_temporary_statuses(
            person_id, status_type, starts_at, ends_at, reason, created_by
          ) VALUES ($1,$2,$3,$4,$5,$1)
          RETURNING *
        `,
        [
          user.personId,
          dto.statusType,
          startsAt.toISOString(),
          endsAt.toISOString(),
          dto.reason ?? null
        ]
      );
      const temporaryStatus = result.rows[0];
      if (!temporaryStatus) {
        throw new BadRequestException('临时状态创建失败');
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, after_data
          ) VALUES ($1,'SET_TEMPORARY_STATUS','PERSON',$1,$2)
        `,
        [user.personId, JSON.stringify(temporaryStatus)]
      );
      return temporaryStatus;
    });
  }
}
