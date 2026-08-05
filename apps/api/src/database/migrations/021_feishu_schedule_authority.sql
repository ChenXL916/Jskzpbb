-- 正式人员排班和主播直播时段恢复以飞书多维表格为主数据源。
-- 本地数据库继续承载预约事务、冲突校验、通知和审计；自动月度方案仅作辅助草案。

INSERT INTO system_settings(
  key, category, value, value_type, description, editable
)
VALUES (
  'schedule.data_authority',
  'SCHEDULE',
  to_jsonb('FEISHU_SCHEDULE_LOCAL_APPOINTMENTS'::text),
  'STRING',
  '正式人员排班与直播时段以飞书表格为准；预约、状态、通知和审计以程序数据库为准',
  false
)
ON CONFLICT (key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  editable=false,
  updated_at=now();

INSERT INTO system_settings(
  key, category, value, value_type, description, editable
)
VALUES (
  'schedule.auto.data_source_mode',
  'SCHEDULE',
  to_jsonb('AUXILIARY_DRAFT'::text),
  'STRING',
  '月度自动排班只生成辅助草案，不得发布覆盖飞书正式排班',
  false
)
ON CONFLICT (key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  editable=false,
  updated_at=now();

UPDATE feishu_table_mappings
SET enabled = business_type IN (
      'STAFF_MONTHLY_SCHEDULE',
      'LIVE_ROOM_MONTHLY_SCHEDULE'
    ),
    sync_direction = CASE
      WHEN business_type IN (
        'STAFF_MONTHLY_SCHEDULE',
        'LIVE_ROOM_MONTHLY_SCHEDULE'
      ) THEN 'FEISHU_TO_LOCAL'
      ELSE sync_direction
    END,
    updated_at=now();

UPDATE feishu_connections
SET enabled=true, updated_at=now();

CREATE INDEX IF NOT EXISTS idx_live_sessions_feishu_active_range
  ON live_sessions(room_id, starts_at, ends_at)
  WHERE status='SCHEDULED' AND cancelled_at IS NULL
    AND source_type='FEISHU';

CREATE INDEX IF NOT EXISTS idx_staff_daily_feishu_active_range
  ON staff_daily_schedules(person_id, schedule_date, starts_at, ends_at)
  WHERE cancelled_at IS NULL
    AND source_type='FEISHU';
