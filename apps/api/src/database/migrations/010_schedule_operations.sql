ALTER TABLE live_sessions
  ADD COLUMN IF NOT EXISTS source_type varchar(30) NOT NULL DEFAULT 'FEISHU',
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE live_sessions
SET source_type='FEISHU'
WHERE source_slot_ids <> ARRAY[]::uuid[];

ALTER TABLE staff_daily_schedules
  ADD COLUMN IF NOT EXISTS source_type varchar(30) NOT NULL DEFAULT 'FEISHU',
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE room_field_controls
  ADD COLUMN IF NOT EXISTS live_session_id uuid REFERENCES live_sessions(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_control_live_session_person
  ON room_field_controls(live_session_id, person_id)
  WHERE live_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_live_sessions_active_range
  ON live_sessions(room_id, starts_at, ends_at)
  WHERE status='SCHEDULED' AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_daily_active_range
  ON staff_daily_schedules(person_id, starts_at, ends_at)
  WHERE cancelled_at IS NULL;

INSERT INTO permissions(code, name, module, description)
VALUES (
  'schedule.manage',
  '编排直播与人员班次',
  'SCHEDULE',
  '新增、调整、取消直播场次和人员日班次'
)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  module=EXCLUDED.module,
  description=EXCLUDED.description,
  updated_at=now();

INSERT INTO role_permissions(role_id, permission_id, granted)
SELECT role.id, permission.id, true
FROM roles role
CROSS JOIN permissions permission
WHERE role.code IN ('LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
  AND permission.code='schedule.manage'
ON CONFLICT (role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();
