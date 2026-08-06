import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { CurrentUser } from '@jishi/contracts';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  GroupNotificationDeliveryService,
  GroupTargetKey
} from './group-notification-delivery.service';
import {
  GroupNotificationQueryDto,
  UpdateScheduleNotificationRuleDto
} from './schedule-notification.dto';

interface NotificationRuleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  trigger_type: 'WEEKLY' | 'EVENT';
  weekday: number | null;
  send_time: string | null;
  timezone: string;
  target_key: GroupTargetKey;
  enabled: boolean;
  effective_from: Date;
  last_enqueued_at: Date | null;
  scheduled_for?: Date;
}

interface AppointmentReference {
  id: string;
  data_version: number;
}

interface Period {
  range_start: Date;
  range_end: Date;
}

interface PublishedSession {
  starts_at: Date;
  ends_at: Date;
  anchor_name: string;
  room_name: string;
}

interface RetryRow {
  id: string;
  status: string;
  target_key: GroupTargetKey;
}

@Injectable()
export class ScheduleNotificationService {
  private readonly logger = new Logger(ScheduleNotificationService.name);
  private schedulerRunning = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly delivery: GroupNotificationDeliveryService
  ) {}

  async rules() {
    const result = await this.db.query<NotificationRuleRow>(
      `
        SELECT id, code, name, description, trigger_type, weekday,
               send_time::text, timezone, target_key, enabled,
               effective_from, last_enqueued_at
        FROM schedule_notification_rules
        ORDER BY CASE code
          WHEN 'SCHEDULE_START_REMINDER' THEN 1
          WHEN 'SCHEDULE_PUBLISH' THEN 2
          ELSE 3
        END
      `
    );
    return result.rows.map((row) => this.presentRule(row));
  }

  async updateRule(
    user: CurrentUser,
    id: string,
    dto: UpdateScheduleNotificationRuleDto
  ) {
    const current = await this.ruleById(id);
    if (
      current.trigger_type === 'EVENT' &&
      (dto.weekday !== undefined || dto.sendTime !== undefined)
    ) {
      throw new BadRequestException('即时事件通知不支持设置星期和发送时间');
    }
    const weekday = dto.weekday ?? current.weekday;
    const sendTime = dto.sendTime ?? current.send_time?.slice(0, 5) ?? null;
    const enabled = dto.enabled ?? current.enabled;
    const result = await this.db.transaction(async (client) => {
      const updated = await client.query<NotificationRuleRow>(
        `
          UPDATE schedule_notification_rules
          SET enabled=$2, weekday=$3, send_time=$4, updated_by=$5
          WHERE id=$1
          RETURNING id, code, name, description, trigger_type, weekday,
                    send_time::text, timezone, target_key, enabled,
                    effective_from, last_enqueued_at
        `,
        [id, enabled, weekday, sendTime, user.personId]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id,
            before_data, after_data
          ) VALUES ($1,'NOTIFICATION_RULE_UPDATE','SCHEDULE_NOTIFICATION_RULE',
                    $2,$3,$4)
        `,
        [user.personId, id, JSON.stringify(current), JSON.stringify(updated.rows[0])]
      );
      return updated.rows[0]!;
    });
    return this.presentRule(result);
  }

  async enqueueTest(user: CurrentUser, id: string) {
    const rule = await this.ruleById(id);
    const target = this.delivery.status(rule.target_key);
    if (!target.configured) {
      throw new BadRequestException(
        `${target.label}尚未配置机器人 Webhook 或 chat_id`
      );
    }
    const text = this.testMessage(rule);
    const result = await this.db.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO notification_outbox(
            event_type, aggregate_type, aggregate_id, audience, target_key,
            idempotency_key, payload
          ) VALUES (
            'GROUP_NOTIFICATION_TEST','SCHEDULE_NOTIFICATION_RULE',$1,
            'GROUP',$2,$3,$4
          )
          RETURNING id
        `,
        [
          rule.id,
          rule.target_key,
          `GROUP_NOTIFICATION_TEST:${rule.id}:${randomUUID()}`,
          JSON.stringify({ text, ruleCode: rule.code })
        ]
      );
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, after_data
          ) VALUES ($1,'GROUP_NOTIFICATION_TEST','SCHEDULE_NOTIFICATION_RULE',
                    $2,$3)
        `,
        [
          user.personId,
          rule.id,
          JSON.stringify({ outboxId: inserted.rows[0]?.id, targetKey: rule.target_key })
        ]
      );
      return inserted.rows[0]!;
    });
    return { ...result, target };
  }

  async outbox(query: GroupNotificationQueryDto) {
    const offset = (query.page - 1) * query.pageSize;
    const values: unknown[] = [query.pageSize, offset];
    const statusFilter = query.status
      ? `AND status=$${values.push(query.status)}`
      : '';
    const [items, count] = await Promise.all([
      this.db.query(
        `
          SELECT id, event_type, aggregate_type, aggregate_id, target_key,
                 status, retry_count, next_attempt_at, last_error,
                 scheduled_for, processed_at, created_at,
                 left(COALESCE(payload->>'text',''), 180) AS message_preview
          FROM notification_outbox
          WHERE audience='GROUP' ${statusFilter}
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2
        `,
        values
      ),
      this.db.query<{ total: number }>(
        `
          SELECT count(*)::int AS total
          FROM notification_outbox
          WHERE audience='GROUP'
          ${query.status ? 'AND status=$1' : ''}
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

  async retry(user: CurrentUser, id: string): Promise<RetryRow> {
    return this.db.transaction(async (client) => {
      const result = await client.query<RetryRow>(
        `
          UPDATE notification_outbox
          SET status='PENDING', retry_count=0, next_attempt_at=now(),
              last_error=NULL, processed_at=NULL
          WHERE id=$1 AND audience='GROUP'
          RETURNING id, status, target_key
        `,
        [id]
      );
      if (!result.rows[0]) {
        throw new NotFoundException('群通知发送记录不存在');
      }
      await client.query(
        `
          INSERT INTO operation_logs(
            actor_id, action, resource_type, resource_id, after_data
          ) VALUES ($1,'GROUP_NOTIFICATION_RETRY','NOTIFICATION_OUTBOX',$2,$3)
        `,
        [user.personId, id, JSON.stringify(result.rows[0])]
      );
      return result.rows[0];
    });
  }

  async enqueueAppointmentBooked(
    client: PoolClient,
    appointment: AppointmentReference,
    eventType: string
  ): Promise<void> {
    if (eventType !== 'APPOINTMENT_BOOKED') return;
    await client.query(
      `
        INSERT INTO notification_outbox(
          event_type, aggregate_type, aggregate_id, audience, target_key,
          idempotency_key, payload
        )
        SELECT
          'APPOINTMENT_BOOKED_GROUP',
          'MAKEUP_APPOINTMENT',
          $1,
          'GROUP',
          rule.target_key,
          $2,
          jsonb_build_object('dataVersion', $3::int, 'ruleCode', rule.code)
        FROM schedule_notification_rules rule
        WHERE rule.code='APPOINTMENT_BOOKED_GROUP'
          AND rule.enabled
          AND rule.effective_from <= now()
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        appointment.id,
        `APPOINTMENT_BOOKED_GROUP:${appointment.id}:${appointment.data_version}`,
        appointment.data_version
      ]
    );
  }

  @Interval(60_000)
  async enqueueDueWeeklyRules(): Promise<void> {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;
    try {
      const due = await this.db.query<NotificationRuleRow>(
        `
          WITH calculated AS (
            SELECT rule.*,
              (
                date_trunc('week', now() AT TIME ZONE rule.timezone)::date
                + (rule.weekday - 1)
                + rule.send_time
              ) AT TIME ZONE rule.timezone AS scheduled_for
            FROM schedule_notification_rules rule
            WHERE rule.trigger_type='WEEKLY' AND rule.enabled
          )
          SELECT *
          FROM calculated
          WHERE effective_from <= now()
            AND scheduled_for <= now()
            AND scheduled_for >= now() - interval '6 hours'
            AND (
              last_enqueued_at IS NULL
              OR last_enqueued_at < scheduled_for
            )
          ORDER BY scheduled_for
        `
      );
      for (const rule of due.rows) {
        await this.enqueueScheduledRule(rule);
      }
    } catch (error) {
      this.logger.error(
        `定时群通知扫描失败：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      this.schedulerRunning = false;
    }
  }

  private async enqueueScheduledRule(rule: NotificationRuleRow): Promise<void> {
    const scheduledFor = rule.scheduled_for;
    if (!scheduledFor) return;
    const text =
      rule.code === 'SCHEDULE_PUBLISH'
        ? await this.schedulePublishMessage(scheduledFor, rule.timezone)
        : await this.scheduleStartMessage(scheduledFor, rule.timezone);
    await this.db.transaction(async (client) => {
      await client.query(
        `
          INSERT INTO notification_outbox(
            event_type, aggregate_type, aggregate_id, audience, target_key,
            idempotency_key, payload, scheduled_for
          ) VALUES ($1,'SCHEDULE_NOTIFICATION_RULE',$2,'GROUP',$3,$4,$5,$6)
          ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          rule.code,
          rule.id,
          rule.target_key,
          `${rule.code}:${scheduledFor.toISOString()}`,
          JSON.stringify({ text, ruleCode: rule.code }),
          scheduledFor
        ]
      );
      await client.query(
        `
          UPDATE schedule_notification_rules
          SET last_enqueued_at=$2
          WHERE id=$1
            AND (last_enqueued_at IS NULL OR last_enqueued_at < $2)
        `,
        [rule.id, scheduledFor]
      );
    });
  }

  private async scheduleStartMessage(
    scheduledFor: Date,
    timezone: string
  ): Promise<string> {
    const period = await this.nextWeekPeriod(scheduledFor, timezone);
    return [
      '【排班提醒】该开始安排下周排班了',
      `排班范围：${this.dateRange(period)}`,
      '请在系统中完成主播直播场次和人员班次安排。',
      '系统会在周六 18:00 自动汇总并通知主播群。',
      `进入排班：${this.config.get<string>('WEB_ORIGIN') ?? ''}/schedule`
    ].join('\n');
  }

  private async schedulePublishMessage(
    scheduledFor: Date,
    timezone: string
  ): Promise<string> {
    const period = await this.nextWeekPeriod(scheduledFor, timezone);
    const sessions = await this.db.query<PublishedSession>(
      `
        SELECT session.starts_at, session.ends_at,
               anchor.display_name AS anchor_name,
               room.name AS room_name
        FROM live_sessions session
        JOIN people anchor ON anchor.id=session.anchor_id
        JOIN rooms room ON room.id=session.room_id
        WHERE session.status='SCHEDULED'
          AND session.source_type='FEISHU'
          AND session.starts_at >= $1
          AND session.starts_at < $2
        ORDER BY session.starts_at, room.sort_order, anchor.display_name
      `,
      [period.range_start, period.range_end]
    );
    if (!sessions.rows.length) {
      return [
        '【下周直播排班提醒】',
        `排班范围：${this.dateRange(period)}`,
        '截至发送时间，系统中还没有有效直播场次。',
        '请联系排班负责人确认，避免遗漏上播安排。',
        `查看排班：${this.config.get<string>('WEB_ORIGIN') ?? ''}/schedule`
      ].join('\n');
    }
    const visible = sessions.rows.slice(0, 70);
    const lines = visible.map(
      (session) =>
        `• ${this.sessionDateFormatter().format(session.starts_at)} ` +
        `${this.timeFormatter().format(session.starts_at)}—` +
        `${this.timeFormatter().format(session.ends_at)}｜` +
        `${session.room_name}｜${session.anchor_name}`
    );
    if (visible.length < sessions.rows.length) {
      lines.push(`…另有 ${sessions.rows.length - visible.length} 场，请进入系统查看`);
    }
    return [
      '【下周直播排班已发布】',
      `排班范围：${this.dateRange(period)}`,
      `共 ${sessions.rows.length} 场，请各位主播核对：`,
      ...lines,
      `查看完整排班：${this.config.get<string>('WEB_ORIGIN') ?? ''}/schedule`
    ].join('\n');
  }

  private async nextWeekPeriod(
    scheduledFor: Date,
    timezone: string
  ): Promise<Period> {
    const result = await this.db.query<Period>(
      `
        SELECT
          (
            date_trunc('week', $1::timestamptz AT TIME ZONE $2)
            + interval '7 days'
          ) AT TIME ZONE $2 AS range_start,
          (
            date_trunc('week', $1::timestamptz AT TIME ZONE $2)
            + interval '14 days'
          ) AT TIME ZONE $2 AS range_end
      `,
      [scheduledFor, timezone]
    );
    return result.rows[0]!;
  }

  private dateRange(period: Period): string {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric'
    });
    const inclusiveEnd = new Date(period.range_end.getTime() - 1);
    return `${formatter.format(period.range_start)}—${formatter.format(inclusiveEnd)}`;
  }

  private sessionDateFormatter(): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short'
    });
  }

  private timeFormatter(): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  private testMessage(rule: NotificationRuleRow): string {
    if (rule.code === 'APPOINTMENT_BOOKED_GROUP') {
      return [
        '【妆造预约通知测试】',
        '预约主播：测试主播',
        '化妆师：测试化妆师',
        '妆造时间：8月8日 16:00—17:00',
        '上播时间：8月8日 18:00',
        '直播间：测试直播间',
        '这是一条配置验证消息，不会创建业务预约。'
      ].join('\n');
    }
    return [
      `【${rule.name}测试】`,
      '群通知通道已连接。',
      '这是一条配置验证消息，不会修改任何排班。'
    ].join('\n');
  }

  private async ruleById(id: string): Promise<NotificationRuleRow> {
    const result = await this.db.query<NotificationRuleRow>(
      `
        SELECT id, code, name, description, trigger_type, weekday,
               send_time::text, timezone, target_key, enabled,
               effective_from, last_enqueued_at
        FROM schedule_notification_rules
        WHERE id=$1
      `,
      [id]
    );
    if (!result.rows[0]) {
      throw new NotFoundException('排班通知规则不存在');
    }
    return result.rows[0];
  }

  private presentRule(row: NotificationRuleRow) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      triggerType: row.trigger_type,
      weekday: row.weekday,
      sendTime: row.send_time?.slice(0, 5) ?? null,
      timezone: row.timezone,
      targetKey: row.target_key,
      enabled: row.enabled,
      effectiveFrom: row.effective_from,
      lastEnqueuedAt: row.last_enqueued_at,
      target: this.delivery.status(row.target_key)
    };
  }
}
