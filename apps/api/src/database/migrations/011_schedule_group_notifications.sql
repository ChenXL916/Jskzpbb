ALTER TABLE notification_outbox
  ADD COLUMN audience varchar(20) NOT NULL DEFAULT 'PERSON',
  ADD COLUMN target_key varchar(60),
  ADD COLUMN scheduled_for timestamptz;

ALTER TABLE notification_outbox
  ADD CONSTRAINT chk_notification_outbox_audience
  CHECK (audience IN ('PERSON', 'GROUP'));

CREATE INDEX idx_outbox_group_pending
  ON notification_outbox(target_key, status, next_attempt_at)
  WHERE audience='GROUP';

CREATE TABLE schedule_notification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(80) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  description text,
  trigger_type varchar(20) NOT NULL,
  weekday smallint,
  send_time time,
  timezone varchar(60) NOT NULL DEFAULT 'Asia/Shanghai',
  target_key varchar(60) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  last_enqueued_at timestamptz,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (trigger_type IN ('WEEKLY', 'EVENT')),
  CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  CHECK (
    (trigger_type='WEEKLY' AND weekday IS NOT NULL AND send_time IS NOT NULL)
    OR (trigger_type='EVENT' AND weekday IS NULL AND send_time IS NULL)
  ),
  CHECK (
    target_key IN (
      'SCHEDULING_GROUP',
      'ANCHOR_GROUP',
      'MAKEUP_GROUP'
    )
  )
);

CREATE TRIGGER trg_schedule_notification_rules_updated_at
BEFORE UPDATE ON schedule_notification_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schedule_notification_rules(
  code, name, description, trigger_type, weekday, send_time,
  target_key, enabled, effective_from
) VALUES
  (
    'SCHEDULE_START_REMINDER',
    '排班开始提醒',
    '提醒排班负责人开始安排下一周直播场次和人员班次',
    'WEEKLY',
    4,
    '17:00',
    'SCHEDULING_GROUP',
    true,
    '2026-08-07 18:00:00+08'
  ),
  (
    'SCHEDULE_PUBLISH',
    '下周排班发布',
    '把系统中下一周的有效直播排班汇总发送到主播群',
    'WEEKLY',
    6,
    '18:00',
    'ANCHOR_GROUP',
    true,
    '2026-08-07 18:00:00+08'
  ),
  (
    'APPOINTMENT_BOOKED_GROUP',
    '妆造预约成功通知',
    '预约成功后立即把主播、上播时间和直播间发到化妆师群',
    'EVENT',
    NULL,
    NULL,
    'MAKEUP_GROUP',
    true,
    '2026-08-07 18:00:00+08'
  )
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  trigger_type=EXCLUDED.trigger_type,
  target_key=EXCLUDED.target_key,
  updated_at=now();

INSERT INTO permissions(code, name, module, description)
VALUES (
  'notifications.manage',
  '管理排班通知',
  'ADMIN',
  '维护定时排班提醒、群通知规则并重试失败消息'
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
WHERE role.code IN ('ADMIN', 'DEVELOPER')
  AND permission.code='notifications.manage'
ON CONFLICT (role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();
