import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';

export function riskSeverity(minutesUntilLive: number): 'REMINDER' | 'WARNING' | 'URGENT' {
  if (minutesUntilLive <= 30) return 'URGENT';
  if (minutesUntilLive <= 120) return 'WARNING';
  return 'REMINDER';
}

@Injectable()
export class RiskEngineService {
  constructor(private readonly db: DatabaseService) {}

  @Cron('0 * * * * *')
  async refresh(): Promise<void> {
    await this.db.transaction(async (client) => {
      const settings = await client.query<{
        key: string;
        value: number;
      }>(
        `
          SELECT key, (value #>> '{}')::int AS value
          FROM system_settings
          WHERE key IN (
            'risk.unbooked_warning_minutes',
            'risk.incomplete_warning_minutes'
          )
        `
      );
      const values = Object.fromEntries(
        settings.rows.map((row) => [row.key, Number(row.value)])
      );
      const unbookedMinutes =
        values['risk.unbooked_warning_minutes'] ?? 120;
      const incompleteMinutes =
        values['risk.incomplete_warning_minutes'] ?? 30;

      await client.query(
        `
          INSERT INTO risk_items(
            risk_type, severity, title, description, live_session_id,
            room_id, person_id, suggestion, fingerprint, occurred_at,
            due_at, metadata
          )
          SELECT
            'UNBOOKED_BEFORE_LIVE',
            CASE
              WHEN session.starts_at <= now() + interval '30 minutes'
                THEN 'URGENT'
              ELSE 'WARNING'
            END,
            '开播临近仍未预约妆造',
            anchor.display_name || ' 的直播即将开始，但还没有有效妆造预约。',
            session.id,
            session.room_id,
            session.anchor_id,
            '立即检查化妆师可用时间并为主播完成预约。',
            md5('UNBOOKED_BEFORE_LIVE:' || session.id::text),
            now(),
            session.starts_at,
            jsonb_build_object('liveStartsAt', session.starts_at)
          FROM live_sessions session
          JOIN people anchor ON anchor.id=session.anchor_id
          WHERE session.status='SCHEDULED' AND session.makeup_required
            AND session.source_type='FEISHU'
            AND session.starts_at > now()
            AND session.starts_at <= now()
              + ($1::int * interval '1 minute')
            AND NOT EXISTS (
              SELECT 1 FROM makeup_appointments appointment
              WHERE appointment.live_session_id=session.id
                AND appointment.source_type<>'FEISHU'
                AND appointment.status IN (
                  'BOOKED','IN_PROGRESS','COMPLETED',
                  'RESCHEDULE_REQUIRED','REASSIGN_REQUIRED','EXCEPTION'
                )
            )
          ON CONFLICT (fingerprint) DO UPDATE SET
            severity=EXCLUDED.severity,
            description=EXCLUDED.description,
            due_at=EXCLUDED.due_at,
            status=CASE
              WHEN risk_items.status IN ('RESOLVED','DISMISSED') THEN 'OPEN'
              ELSE risk_items.status
            END,
            updated_at=now()
        `,
        [unbookedMinutes]
      );

      await client.query(
        `
          INSERT INTO risk_items(
            risk_type, severity, title, description, appointment_id,
            live_session_id, room_id, person_id, suggestion, fingerprint,
            occurred_at, due_at, metadata
          )
          SELECT
            'MAKEUP_INCOMPLETE_BEFORE_LIVE',
            CASE
              WHEN session.starts_at <= now() + interval '15 minutes'
                THEN 'URGENT'
              ELSE 'WARNING'
            END,
            '开播临近妆造仍未完成',
            anchor.display_name || ' 的妆造状态为“'
              || appointment.status::text || '”。',
            appointment.id,
            session.id,
            session.room_id,
            session.anchor_id,
            '联系主播和化妆师确认进度，必要时调整开播准备。',
            md5('MAKEUP_INCOMPLETE_BEFORE_LIVE:' || appointment.id::text),
            now(),
            session.starts_at,
            jsonb_build_object(
              'liveStartsAt', session.starts_at,
              'appointmentStatus', appointment.status
            )
          FROM makeup_appointments appointment
          JOIN live_sessions session ON session.id=appointment.live_session_id
          JOIN people anchor ON anchor.id=appointment.anchor_id
          WHERE appointment.status IN (
              'BOOKED','IN_PROGRESS','EXCEPTION',
              'RESCHEDULE_REQUIRED','REASSIGN_REQUIRED'
            )
            AND appointment.source_type<>'FEISHU'
            AND session.source_type='FEISHU'
            AND session.status='SCHEDULED'
            AND session.starts_at > now()
            AND session.starts_at <= now()
              + ($1::int * interval '1 minute')
          ON CONFLICT (fingerprint) DO UPDATE SET
            severity=EXCLUDED.severity,
            description=EXCLUDED.description,
            due_at=EXCLUDED.due_at,
            status=CASE
              WHEN risk_items.status IN ('RESOLVED','DISMISSED') THEN 'OPEN'
              ELSE risk_items.status
            END,
            updated_at=now()
        `,
        [incompleteMinutes]
      );

      await client.query(
        `
          INSERT INTO risk_items(
            risk_type, severity, title, description, appointment_id,
            live_session_id, room_id, person_id, suggestion, fingerprint,
            occurred_at, due_at, metadata
          )
          SELECT
            'MAKEUP_OVERRUN',
            'URGENT',
            '妆造已超过计划结束时间',
            anchor.display_name || ' 的妆造仍在进行，可能影响开播。',
            appointment.id,
            appointment.live_session_id,
            appointment.room_id,
            appointment.anchor_id,
            '立即确认预计完成时间，并通知对应场控。',
            md5('MAKEUP_OVERRUN:' || appointment.id::text),
            now(),
            session.starts_at,
            jsonb_build_object(
              'plannedEndAt', appointment.planned_end_at,
              'liveStartsAt', session.starts_at
            )
          FROM makeup_appointments appointment
          JOIN live_sessions session ON session.id=appointment.live_session_id
          JOIN people anchor ON anchor.id=appointment.anchor_id
          WHERE appointment.status IN ('IN_PROGRESS','EXCEPTION')
            AND appointment.source_type<>'FEISHU'
            AND session.source_type='FEISHU'
            AND appointment.planned_end_at < now()
          ON CONFLICT (fingerprint) DO UPDATE SET
            description=EXCLUDED.description,
            due_at=EXCLUDED.due_at,
            status=CASE
              WHEN risk_items.status IN ('RESOLVED','DISMISSED') THEN 'OPEN'
              ELSE risk_items.status
            END,
            updated_at=now()
        `
      );

      await client.query(
        `
          UPDATE risk_items risk
          SET status='RESOLVED', resolved_at=now(),
              resolution_note='系统检测到风险条件已经解除',
              updated_at=now()
          WHERE risk.status IN ('OPEN','ACKNOWLEDGED')
            AND (
              (
                risk.risk_type='UNBOOKED_BEFORE_LIVE'
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM live_sessions session
                    WHERE session.id=risk.live_session_id
                      AND session.status='SCHEDULED'
                      AND session.starts_at > now()
                  )
                  OR EXISTS (
                    SELECT 1 FROM makeup_appointments appointment
                    WHERE appointment.live_session_id=risk.live_session_id
                      AND appointment.status IN (
                        'BOOKED','IN_PROGRESS','COMPLETED','EXCEPTION'
                      )
                  )
                )
              )
              OR (
                risk.risk_type IN (
                  'MAKEUP_INCOMPLETE_BEFORE_LIVE','MAKEUP_OVERRUN'
                )
                AND EXISTS (
                  SELECT 1 FROM makeup_appointments appointment
                  WHERE appointment.id=risk.appointment_id
                    AND appointment.status IN ('COMPLETED','CANCELLED')
                )
              )
            )
        `
      );
    });
  }
}
