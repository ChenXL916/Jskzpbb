-- 月度排班第二阶段：编辑历史、周期可用性、工时折算与导入逐行结果。
-- 只增加结构，不改写既有正式排班。

ALTER TABLE people
  ADD COLUMN employment_started_on date,
  ADD COLUMN employment_ended_on date;

ALTER TABLE people
  ADD CONSTRAINT people_employment_date_order_check
  CHECK (
    employment_ended_on IS NULL
    OR employment_started_on IS NULL
    OR employment_ended_on >= employment_started_on
  );

CREATE TABLE schedule_plan_edit_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES monthly_schedule_plans(id) ON DELETE CASCADE,
  operation_type varchar(50) NOT NULL,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'APPLIED'
    CHECK (status IN ('APPLIED','UNDONE','DISCARDED')),
  reason text,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_by uuid REFERENCES people(id) ON DELETE SET NULL,
  undone_at timestamptz
);
CREATE INDEX idx_schedule_plan_edit_history_plan
  ON schedule_plan_edit_history(plan_id, created_at DESC);
CREATE INDEX idx_schedule_plan_edit_history_active
  ON schedule_plan_edit_history(plan_id, status, created_at DESC);

CREATE TABLE schedule_import_job_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES schedule_import_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL CHECK (row_number > 0),
  source_data jsonb NOT NULL DEFAULT '{}',
  normalized_data jsonb NOT NULL DEFAULT '{}',
  status varchar(20) NOT NULL
    CHECK (status IN ('VALID','IMPORTED','SKIPPED','ERROR','ROLLED_BACK')),
  error_code varchar(80),
  error_message text,
  resource_type varchar(50),
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, row_number)
);
CREATE INDEX idx_schedule_import_job_items_job
  ON schedule_import_job_items(job_id, status, row_number);

INSERT INTO permissions(code,name,module,description) VALUES
  ('schedule.plan.import','导入自动排班主数据','SCHEDULE','导入主播、资格、可用性、能力和覆盖模板'),
  ('schedule.plan.history','撤销与重做排班编辑','SCHEDULE','查看并恢复月度排班编辑历史')
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  module=EXCLUDED.module,
  description=EXCLUDED.description,
  updated_at=now();

INSERT INTO role_permissions(role_id,permission_id,granted)
SELECT role.id, permission.id, true
FROM roles role
CROSS JOIN permissions permission
WHERE role.code IN ('LIVE_SUPERVISOR','ADMIN','DEVELOPER')
  AND permission.code IN ('schedule.plan.import','schedule.plan.history')
ON CONFLICT(role_id,permission_id) DO UPDATE SET granted=true,updated_at=now();
