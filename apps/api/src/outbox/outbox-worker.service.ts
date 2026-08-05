import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { FeishuClient } from '../feishu/feishu.client';
import {
  GroupNotificationDeliveryService,
  GroupTargetNotConfiguredError
} from './group-notification-delivery.service';
import { feishuMention } from './feishu-mention';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  retry_count: number;
  recipient_person_id: string | null;
  audience: 'PERSON' | 'GROUP';
  target_key: string | null;
  payload: Record<string, unknown>;
}

interface AppointmentMessageRow {
  appointment_no: string;
  status: string;
  subject_name: string;
  subject_type: 'ANCHOR' | 'TALENT' | 'DIRECTOR';
  artist_name: string;
  artist_open_id: string | null;
  room_name: string;
  planned_start_at: Date;
  planned_end_at: Date;
  live_starts_at: Date | null;
}

interface LiveSessionMessageRow {
  anchor_name: string;
  room_name: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
}

interface StaffShiftMessageRow {
  display_name: string;
  schedule_date: string;
  raw_shift_value: string;
  starts_at: Date | null;
  ends_at: Date | null;
  cancelled_at: Date | null;
}

@Injectable()
export class OutboxWorkerService {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly feishu: FeishuClient,
    private readonly groupDelivery: GroupNotificationDeliveryService
  ) {}

  @Interval(15_000)
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.claim();
      for (const row of rows) {
        await this.deliver(row);
      }
    } finally {
      this.running = false;
    }
  }

  private claim(): Promise<OutboxRow[]> {
    return this.db.transaction(async (client) => {
      const result = await client.query<OutboxRow>(
        `
          SELECT id, aggregate_id, aggregate_type, event_type,
                 retry_count, recipient_person_id, audience, target_key,
                 payload
          FROM notification_outbox
          WHERE (
              status IN ('PENDING','FAILED','WAITING_CONFIGURATION')
              AND next_attempt_at <= now()
            )
            OR (
              status='RUNNING'
              AND next_attempt_at <= now() - interval '5 minutes'
            )
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 20
        `
      );
      if (result.rows.length) {
        await client.query(
          `
            UPDATE notification_outbox
            SET status='RUNNING', next_attempt_at=now() + interval '5 minutes'
            WHERE id=ANY($1::uuid[])
          `,
          [result.rows.map((row) => row.id)]
        );
      }
      return result.rows;
    });
  }

  private async deliver(row: OutboxRow): Promise<void> {
    try {
      const message = await this.resolveMessage(row);
      if (row.audience === 'GROUP') {
        if (!row.target_key) throw new Error('群通知缺少 target_key');
        await this.groupDelivery.send(row.target_key, message);
      } else {
        if (
          !this.feishu.isConfigured() ||
          !this.config.get<boolean>('FEISHU_SYNC_ENABLED')
        ) {
          throw new PersonalNotificationNotConfiguredError();
        }
        const recipient = await this.db.query<{
          feishu_open_id: string | null;
        }>(
          'SELECT feishu_open_id FROM people WHERE id=$1',
          [row.recipient_person_id]
        );
        const openId = recipient.rows[0]?.feishu_open_id;
        if (!openId) throw new Error('通知接收人尚未绑定飞书 open_id');
        await this.feishu.sendTextMessage(openId, message);
      }
      await this.db.query(
        `
          UPDATE notification_outbox
          SET status='SUCCEEDED', processed_at=now(), last_error=NULL
          WHERE id=$1
        `,
        [row.id]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`notification ${row.id} failed: ${message}`);
      if (
        error instanceof GroupTargetNotConfiguredError ||
        error instanceof PersonalNotificationNotConfiguredError
      ) {
        await this.db.query(
          `
            UPDATE notification_outbox
            SET status='WAITING_CONFIGURATION',
                next_attempt_at=now() + interval '5 minutes',
                last_error=$2
            WHERE id=$1
          `,
          [row.id, message]
        );
        return;
      }
      await this.db.query(
        `
          UPDATE notification_outbox
          SET status=CASE WHEN retry_count >= 9 THEN 'DEAD' ELSE 'FAILED' END,
              retry_count=retry_count+1,
              next_attempt_at=now() + make_interval(secs => LEAST(3600, 30 * power(2, retry_count)::int)),
              last_error=$2
          WHERE id=$1
        `,
        [row.id, message]
      );
    }
  }

  private async resolveMessage(row: OutboxRow): Promise<string> {
    if (row.audience === 'GROUP' && typeof row.payload.text === 'string') {
      return row.payload.text;
    }
    if (row.aggregate_type === 'LIVE_SESSION') {
      const result = await this.db.query<LiveSessionMessageRow>(
        `
          SELECT anchor.display_name AS anchor_name, room.name AS room_name,
                 session.starts_at, session.ends_at, session.status
          FROM live_sessions session
          JOIN people anchor ON anchor.id=session.anchor_id
          JOIN rooms room ON room.id=session.room_id
          WHERE session.id=$1
        `,
        [row.aggregate_id]
      );
      if (!result.rows[0]) throw new Error('通知关联直播场次不存在');
      return this.liveSessionMessage(row.event_type, result.rows[0]);
    }
    if (row.aggregate_type === 'STAFF_SCHEDULE') {
      const result = await this.db.query<StaffShiftMessageRow>(
        `
          SELECT person.display_name, schedule.schedule_date::text,
                 schedule.raw_shift_value, schedule.starts_at,
                 schedule.ends_at, schedule.cancelled_at
          FROM staff_daily_schedules schedule
          JOIN people person ON person.id=schedule.person_id
          WHERE schedule.id=$1
        `,
        [row.aggregate_id]
      );
      if (!result.rows[0]) throw new Error('通知关联人员班次不存在');
      return this.staffShiftMessage(row.event_type, result.rows[0]);
    }
    const appointment = await this.db.query<AppointmentMessageRow>(
        `
          SELECT a.appointment_no, a.status,
                 subject.display_name AS subject_name,
                 a.subject_type,
                 artist.display_name AS artist_name,
                 artist.feishu_open_id AS artist_open_id,
                 COALESCE(r.name, a.location) AS room_name,
                 a.planned_start_at, a.planned_end_at,
                 ls.starts_at AS live_starts_at
          FROM makeup_appointments a
          JOIN people subject ON subject.id=a.subject_person_id
          JOIN people artist ON artist.id=a.makeup_artist_id
          LEFT JOIN rooms r ON r.id=a.room_id
          LEFT JOIN live_sessions ls ON ls.id=a.live_session_id
          WHERE a.id=$1
        `,
        [row.aggregate_id]
    );
    if (!appointment.rows[0]) throw new Error('通知关联预约不存在');
    if (row.audience === 'GROUP') {
      return this.appointmentGroupMessage(appointment.rows[0]);
    }
    return this.message(row.event_type, appointment.rows[0]);
  }

  private appointmentGroupMessage(row: AppointmentMessageRow): string {
    const time = this.timeFormatter();
    const artistMention = feishuMention(row.artist_open_id, row.artist_name);
    const lines = [
      '【新增妆造预约】',
      `${artistMention}，您有一条新的妆造任务`,
      `预约对象：${row.subject_name}（${this.subjectTypeLabel(row.subject_type)}）`,
      `化妆师：${row.artist_name}`,
      `妆造时间：${time.format(row.planned_start_at)}—${time.format(row.planned_end_at)}`,
      ...(row.live_starts_at
        ? [`上播时间：${time.format(row.live_starts_at)}`]
        : []),
      `${row.live_starts_at ? '直播间' : '妆造地点'}：${row.room_name}`,
      `预约单：${row.appointment_no}`
    ];
    return lines.join('\n');
  }

  private message(eventType: string, row: AppointmentMessageRow): string {
    const time = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const action =
      eventType === 'APPOINTMENT_IN_PROGRESS'
        ? '妆造已经开始'
        : eventType === 'APPOINTMENT_COMPLETED'
          ? '妆造已经完成'
          : eventType.includes('REASSIGN')
            ? '妆造预约需要重新分配'
            : eventType.includes('RESCHEDULE')
              ? '妆造预约需要改期'
              : '妆造预约成功';
    const lines = [
      `【吉拾开张】${action}`,
      `妆造对象：${row.subject_name}（${this.subjectTypeLabel(row.subject_type)}）`,
      `化妆师：${row.artist_name}`,
      `${row.live_starts_at ? '直播间' : '妆造地点'}：${row.room_name}`,
      `妆造：${time.format(row.planned_start_at)}—${time.format(row.planned_end_at)}`,
      ...(row.live_starts_at ? [`开播：${time.format(row.live_starts_at)}`] : []),
      `预约单：${row.appointment_no}`
    ];
    return lines.join('\n');
  }

  private subjectTypeLabel(type: AppointmentMessageRow['subject_type']): string {
    if (type === 'TALENT') return '达人';
    if (type === 'DIRECTOR') return '编导';
    return '主播';
  }

  private liveSessionMessage(
    eventType: string,
    row: LiveSessionMessageRow
  ): string {
    const time = this.timeFormatter();
    const action = eventType.endsWith('CREATED')
      ? '新增直播排班'
      : eventType.endsWith('CANCELLED')
        ? '直播排班取消'
        : '直播排班调整';
    return [
      `【吉拾开张】${action}`,
      `主播：${row.anchor_name}`,
      `直播间：${row.room_name}`,
      `时间：${time.format(row.starts_at)}—${time.format(row.ends_at)}`,
      `状态：${row.status}`
    ].join('\n');
  }

  private staffShiftMessage(
    eventType: string,
    row: StaffShiftMessageRow
  ): string {
    const time = this.timeFormatter();
    const action = eventType.endsWith('CREATED')
      ? '新增人员班次'
      : eventType.endsWith('CANCELLED')
        ? '人员班次取消'
        : '人员班次调整';
    return [
      `【吉拾开张】${action}`,
      `人员：${row.display_name}`,
      `日期：${row.schedule_date}`,
      `班次：${row.raw_shift_value}`,
      row.starts_at && row.ends_at
        ? `时间：${time.format(row.starts_at)}—${time.format(row.ends_at)}`
        : '时间：休息、请假或待确认',
      `状态：${row.cancelled_at ? '已取消' : '有效'}`
    ].join('\n');
  }

  private timeFormatter(): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
}

class PersonalNotificationNotConfiguredError extends Error {
  constructor() {
    super('飞书应用消息尚未启用或凭证未配置');
  }
}
