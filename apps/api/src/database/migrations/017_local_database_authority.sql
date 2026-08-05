-- 排班、人员班次和妆造预约以程序数据库为唯一业务主数据。
-- 保留历史飞书镜像记录用于审计，但关闭所有表格同步和写回。

INSERT INTO system_settings(
  key, category, value, value_type, description, editable
)
VALUES (
  'schedule.data_authority',
  'SCHEDULE',
  to_jsonb('LOCAL_DATABASE'::text),
  'STRING',
  '排班业务唯一主数据来源；飞书表格不参与排班、工时、冲突或预约计算',
  false
)
ON CONFLICT (key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  editable=false,
  updated_at=now();

UPDATE feishu_table_mappings
SET enabled=false, updated_at=now()
WHERE enabled;

UPDATE feishu_write_outbox
SET status='CANCELLED',
    processed_at=COALESCE(processed_at, now()),
    last_error='系统已切换为本地数据库权威模式，不再写回飞书表格'
WHERE status IN ('PENDING','FAILED','RUNNING');

DROP INDEX IF EXISTS uq_active_appointment_per_session;
CREATE UNIQUE INDEX uq_active_appointment_per_session
  ON makeup_appointments(anchor_id, live_session_id)
  WHERE status IN (
    'BOOKED', 'IN_PROGRESS', 'RESCHEDULE_REQUIRED', 'REASSIGN_REQUIRED', 'EXCEPTION'
  ) AND source_type<>'FEISHU';

ALTER TABLE makeup_appointments
  DROP CONSTRAINT IF EXISTS no_overlapping_active_artist_appointments;
ALTER TABLE makeup_appointments
  ADD CONSTRAINT no_overlapping_active_artist_appointments
  EXCLUDE USING gist (
    makeup_artist_id WITH =,
    tstzrange(planned_start_at, planned_end_at, '[)') WITH &&
  )
  WHERE (
    status IN (
      'BOOKED', 'IN_PROGRESS', 'RESCHEDULE_REQUIRED', 'REASSIGN_REQUIRED', 'EXCEPTION'
    ) AND source_type<>'FEISHU'
  );

CREATE INDEX IF NOT EXISTS idx_live_sessions_local_active_range
  ON live_sessions(room_id, starts_at, ends_at)
  WHERE status='SCHEDULED' AND cancelled_at IS NULL
    AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN');

CREATE INDEX IF NOT EXISTS idx_staff_daily_local_active_range
  ON staff_daily_schedules(person_id, schedule_date, starts_at, ends_at)
  WHERE cancelled_at IS NULL
    AND source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN');
