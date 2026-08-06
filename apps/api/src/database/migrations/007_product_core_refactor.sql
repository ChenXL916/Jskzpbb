CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description text,
  system_role boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(100) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  module varchar(60) NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role_bindings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  assigned_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_role_bindings_user
  ON user_role_bindings(user_id) WHERE enabled = true;

CREATE TABLE shift_template_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_template_id uuid NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
  alias varchar(100) NOT NULL,
  normalized_alias varchar(100) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_alias)
);

CREATE INDEX idx_shift_template_aliases_template
  ON shift_template_aliases(shift_template_id);

CREATE TABLE appointment_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES makeup_appointments(id) ON DELETE CASCADE,
  exception_type varchar(60) NOT NULL,
  severity varchar(20) NOT NULL DEFAULT 'WARNING',
  note text,
  status varchar(20) NOT NULL DEFAULT 'OPEN',
  reported_by uuid REFERENCES people(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES people(id) ON DELETE SET NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (severity IN ('REMINDER', 'WARNING', 'URGENT')),
  CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'))
);

CREATE INDEX idx_appointment_exceptions_open
  ON appointment_exceptions(status, reported_at DESC)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED');

CREATE TABLE person_temporary_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status_type varchar(40) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  cancelled_by uuid REFERENCES people(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status_type IN ('BREAK', 'LEAVE', 'UNAVAILABLE', 'TRAINING')),
  CHECK (ends_at > starts_at)
);

CREATE INDEX idx_person_temporary_statuses_active
  ON person_temporary_statuses(person_id, starts_at, ends_at)
  WHERE cancelled_at IS NULL;

CREATE TABLE risk_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_type varchar(60) NOT NULL,
  severity varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'OPEN',
  title varchar(255) NOT NULL,
  description text NOT NULL,
  appointment_id uuid REFERENCES makeup_appointments(id) ON DELETE CASCADE,
  live_session_id uuid REFERENCES live_sessions(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES people(id) ON DELETE SET NULL,
  suggestion text,
  source_type varchar(40) NOT NULL DEFAULT 'SYSTEM',
  fingerprint varchar(128) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  acknowledged_by uuid REFERENCES people(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_by uuid REFERENCES people(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_note text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fingerprint),
  CHECK (severity IN ('REMINDER', 'WARNING', 'URGENT')),
  CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'))
);

CREATE INDEX idx_risk_items_open
  ON risk_items(status, severity, due_at)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED');
CREATE INDEX idx_risk_items_room
  ON risk_items(room_id, occurred_at DESC);

CREATE TABLE sync_job_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  source_record_id varchar(128),
  operation varchar(30) NOT NULL,
  status varchar(20) NOT NULL,
  local_resource_type varchar(50),
  local_resource_id uuid,
  retry_count integer NOT NULL DEFAULT 0,
  error_code varchar(80),
  error_message text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, source_record_id, operation),
  CHECK (status IN ('PENDING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'CONFLICT'))
);

CREATE INDEX idx_sync_job_items_job_status
  ON sync_job_items(job_id, status);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  event_type varchar(100) NOT NULL,
  title varchar(255) NOT NULL,
  body text NOT NULL,
  resource_type varchar(50),
  resource_id uuid,
  severity varchar(20) NOT NULL DEFAULT 'INFO',
  read_at timestamptz,
  archived_at timestamptz,
  source_outbox_id uuid REFERENCES notification_outbox(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (severity IN ('INFO', 'SUCCESS', 'WARNING', 'ERROR'))
);

CREATE INDEX idx_notifications_recipient_unread
  ON notifications(recipient_person_id, created_at DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;

CREATE TABLE system_settings (
  key varchar(120) PRIMARY KEY,
  category varchar(60) NOT NULL,
  value jsonb NOT NULL,
  value_type varchar(30) NOT NULL DEFAULT 'JSON',
  description text,
  editable boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles(code, name, description, sort_order) VALUES
  ('ANCHOR', '主播', '查看本人直播排班并创建妆造预约', 10),
  ('MAKEUP_ARTIST', '化妆师', '查看本人班次和妆造任务并执行服务', 20),
  ('FIELD_CONTROL', '场控', '查看授权直播间并处理妆造风险', 30),
  ('LIVE_SUPERVISOR', '直播主管', '管理直播间排班、风险与工作量', 40),
  ('ADMIN', '系统管理员', '管理人员、权限、规则和飞书数据源', 50),
  ('DEVELOPER', '开发者', '拥有全部功能和诊断信息', 60)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  enabled = true,
  updated_at = now();

INSERT INTO permissions(code, name, module, description) VALUES
  ('schedule.view.self', '查看个人排班', 'SCHEDULE', '查看本人班次和直播场次'),
  ('schedule.view.room', '查看直播间排班', 'SCHEDULE', '查看数据范围内直播间排班'),
  ('schedule.view.all', '查看全部排班', 'SCHEDULE', '查看全部人员和直播间排班'),
  ('appointment.create', '创建预约', 'APPOINTMENT', '为本人创建妆造预约'),
  ('appointment.create_for_anchor', '代主播预约', 'APPOINTMENT', '为数据范围内主播创建预约'),
  ('appointment.update', '修改预约', 'APPOINTMENT', '修改有效预约'),
  ('appointment.cancel', '取消预约', 'APPOINTMENT', '取消有效预约'),
  ('appointment.start', '开始妆造', 'APPOINTMENT', '开始分配给本人的妆造任务'),
  ('appointment.complete', '完成妆造', 'APPOINTMENT', '完成分配给本人的妆造任务'),
  ('shift.manage', '管理班次', 'ADMIN', '维护班次模板和别名'),
  ('people.manage', '管理人员', 'ADMIN', '维护人员、角色和数据范围'),
  ('feishu.manage', '管理飞书数据源', 'ADMIN', '维护映射并执行同步'),
  ('logs.view', '查看日志', 'ADMIN', '查看同步和操作日志'),
  ('settings.manage', '管理系统规则', 'ADMIN', '维护预约规则和系统配置')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  module = EXCLUDED.module,
  description = EXCLUDED.description,
  updated_at = now();

INSERT INTO role_permissions(role_id, permission_id)
SELECT role_row.id, permission_row.id
FROM roles role_row
JOIN permissions permission_row ON (
  (role_row.code = 'ANCHOR' AND permission_row.code IN (
    'schedule.view.self', 'appointment.create', 'appointment.update', 'appointment.cancel'
  ))
  OR (role_row.code = 'MAKEUP_ARTIST' AND permission_row.code IN (
    'schedule.view.self', 'appointment.start', 'appointment.complete'
  ))
  OR (role_row.code = 'FIELD_CONTROL' AND permission_row.code IN (
    'schedule.view.self', 'schedule.view.room', 'appointment.create_for_anchor',
    'appointment.update', 'appointment.cancel'
  ))
  OR (role_row.code = 'LIVE_SUPERVISOR' AND permission_row.code IN (
    'schedule.view.self', 'schedule.view.room', 'schedule.view.all',
    'appointment.create_for_anchor', 'appointment.update', 'appointment.cancel',
    'logs.view'
  ))
  OR (role_row.code IN ('ADMIN', 'DEVELOPER'))
)
ON CONFLICT (role_id, permission_id) DO UPDATE SET
  granted = true,
  updated_at = now();

INSERT INTO user_role_bindings(user_id, role_id)
SELECT DISTINCT users.id, roles.id
FROM users
JOIN person_roles ON person_roles.person_id = users.person_id
  AND person_roles.enabled = true
JOIN roles ON roles.code = person_roles.role::text
ON CONFLICT (user_id, role_id) DO UPDATE SET
  enabled = true,
  updated_at = now();

INSERT INTO shift_template_aliases(shift_template_id, alias, normalized_alias)
SELECT shift_templates.id, aliases.alias, lower(regexp_replace(aliases.alias, '\s+', '', 'g'))
FROM shift_templates
JOIN LATERAL (
  SELECT unnest(
    CASE shift_templates.name
      WHEN '00-08' THEN ARRAY['00-08', '凌晨']
      WHEN '08-17' THEN ARRAY['08-17', '早', '早班']
      WHEN '12-20' THEN ARRAY['12-20', '中班']
      WHEN '20-05' THEN ARRAY['20-05', '晚', '晚班']
      WHEN '行政班' THEN ARRAY['行政班']
      WHEN '自由班' THEN ARRAY['自由班', '自由（8小时）', '自由(8小时)']
      WHEN '休息' THEN ARRAY['休息', '休']
      ELSE ARRAY[shift_templates.name]
    END
  ) AS alias
) aliases ON true
ON CONFLICT (normalized_alias) DO NOTHING;

INSERT INTO system_settings(key, category, value, value_type, description) VALUES
  ('booking.full_makeup_minutes', 'BOOKING', '60', 'INTEGER', '完整妆造默认时长（分钟）'),
  ('booking.touch_up_minutes', 'BOOKING', '30', 'INTEGER', '补妆默认时长（分钟）'),
  ('booking.trial_minutes', 'BOOKING', '90', 'INTEGER', '试妆默认时长（分钟）'),
  ('booking.live_buffer_minutes', 'BOOKING', '15', 'INTEGER', '开播前安全缓冲（分钟）'),
  ('booking.buffer_before_minutes', 'BOOKING', '0', 'INTEGER', '预约前缓冲（分钟）'),
  ('booking.buffer_after_minutes', 'BOOKING', '15', 'INTEGER', '预约后缓冲（分钟）'),
  ('booking.earliest_notice_minutes', 'BOOKING', '0', 'INTEGER', '最早可预约提前量（分钟）'),
  ('booking.latest_cancel_minutes', 'BOOKING', '30', 'INTEGER', '开播前允许取消时间（分钟）'),
  ('risk.unbooked_warning_minutes', 'RISK', '120', 'INTEGER', '未预约风险预警时间（分钟）'),
  ('risk.incomplete_warning_minutes', 'RISK', '30', 'INTEGER', '未完成风险预警时间（分钟）'),
  ('booking.anchor_reschedule_enabled', 'BOOKING', 'true', 'BOOLEAN', '是否允许主播改期'),
  ('booking.field_control_proxy_enabled', 'BOOKING', 'true', 'BOOLEAN', '是否允许场控代预约'),
  ('booking.prefer_recent_artist', 'BOOKING', 'true', 'BOOLEAN', '是否优先最近合作化妆师'),
  ('booking.balance_workload', 'BOOKING', 'true', 'BOOLEAN', '是否均衡化妆师任务'),
  ('booking.auto_reassign', 'BOOKING', 'false', 'BOOLEAN', '是否自动重新分配')
ON CONFLICT (key) DO NOTHING;

DROP INDEX IF EXISTS uq_active_appointment_per_session;
CREATE UNIQUE INDEX uq_active_appointment_per_session
  ON makeup_appointments(anchor_id, live_session_id)
  WHERE status IN (
    'BOOKED', 'IN_PROGRESS', 'RESCHEDULE_REQUIRED', 'REASSIGN_REQUIRED', 'EXCEPTION'
  );

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
    )
  );

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'roles', 'permissions', 'role_permissions', 'user_role_bindings',
    'shift_template_aliases', 'appointment_exceptions',
    'person_temporary_statuses', 'risk_items', 'sync_job_items',
    'system_settings'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END $$;
