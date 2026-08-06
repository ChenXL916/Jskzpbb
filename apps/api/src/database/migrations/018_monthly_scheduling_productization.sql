-- 主播月度自动排班产品化：本地数据源、覆盖模板、可用性、规则版本、
-- 草案锁定、能力快照、版本变更和发布记录。所有变更均为增量迁移。

CREATE TABLE scheduling_data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  source_type varchar(30) NOT NULL
    CHECK (source_type IN ('LOCAL_DATABASE','FEISHU_ARCHIVE')),
  is_primary boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  read_only boolean NOT NULL DEFAULT false,
  status varchar(30) NOT NULL DEFAULT 'READY'
    CHECK (status IN ('READY','DISABLED','ERROR')),
  configuration jsonb NOT NULL DEFAULT '{}',
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_scheduling_primary_source
  ON scheduling_data_sources(is_primary) WHERE is_primary;

INSERT INTO scheduling_data_sources(
  code, name, source_type, is_primary, enabled, read_only, status, configuration
) VALUES
  ('LOCAL_DATABASE','本地程序数据库','LOCAL_DATABASE',true,true,false,'READY',
   '{"authoritative":true,"runtimeDependency":"NONE"}'::jsonb),
  ('FEISHU_ARCHIVE','飞书历史归档','FEISHU_ARCHIVE',false,false,true,'DISABLED',
   '{"participatesInScheduling":false,"historicalOnly":true}'::jsonb)
ON CONFLICT(code) DO UPDATE SET
  is_primary=EXCLUDED.is_primary,
  enabled=EXCLUDED.enabled,
  read_only=EXCLUDED.read_only,
  status=EXCLUDED.status,
  configuration=EXCLUDED.configuration,
  updated_at=now();

CREATE TABLE schedule_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  version integer NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  max_session_minutes integer NOT NULL DEFAULT 300
    CHECK (max_session_minutes BETWEEN 30 AND 300),
  min_rest_minutes integer NOT NULL DEFAULT 480
    CHECK (min_rest_minutes BETWEEN 0 AND 1440),
  full_time_min_monthly_minutes integer NOT NULL DEFAULT 6240
    CHECK (full_time_min_monthly_minutes >= 0),
  full_time_target_monthly_minutes integer NOT NULL DEFAULT 7020
    CHECK (full_time_target_monthly_minutes >= 0),
  full_time_max_monthly_minutes integer NOT NULL DEFAULT 7800
    CHECK (full_time_max_monthly_minutes >= full_time_target_monthly_minutes),
  prorate_partial_month boolean NOT NULL DEFAULT true,
  part_time_min_monthly_minutes integer NOT NULL DEFAULT 0,
  part_time_max_monthly_minutes integer,
  confidence_a_min_hours numeric(8,2) NOT NULL DEFAULT 60,
  confidence_b_min_hours numeric(8,2) NOT NULL DEFAULT 30,
  strong_score_threshold numeric(8,3) NOT NULL DEFAULT 102,
  weak_score_threshold numeric(8,3) NOT NULL DEFAULT 98,
  strategy_weights jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);
CREATE UNIQUE INDEX uq_schedule_rule_sets_active
  ON schedule_rule_sets(status) WHERE status='ACTIVE';

INSERT INTO schedule_rule_sets(
  name, version, status, strategy_weights
) VALUES (
  '默认月度主播排班规则', 1, 'ACTIVE',
  '{
    "BUSINESS":{"ability":1.0,"fairness":0.35,"fragmentation":0.35},
    "BALANCED":{"ability":0.7,"fairness":0.8,"fragmentation":0.65},
    "CALIBRATION":{"ability":0.4,"fairness":0.55,"fragmentation":0.45,"lowConfidenceExposure":0.8}
  }'::jsonb
) ON CONFLICT(name, version) DO NOTHING;

CREATE TABLE schedule_time_bands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40) NOT NULL UNIQUE,
  name varchar(80) NOT NULL,
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);

INSERT INTO schedule_time_bands(code,name,start_minute,end_minute,sort_order) VALUES
  ('BAND_00_04','凌晨 00:00-04:00',0,240,10),
  ('BAND_04_08','清晨 04:00-08:00',240,480,20),
  ('BAND_08_12','早间 08:00-12:00',480,720,30),
  ('BAND_12_16','午间 12:00-16:00',720,960,40),
  ('BAND_16_20','晚间 16:00-20:00',960,1200,50),
  ('BAND_20_24','夜间 20:00-24:00',1200,1440,60)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  start_minute=EXCLUDED.start_minute,
  end_minute=EXCLUDED.end_minute,
  sort_order=EXCLUDED.sort_order,
  enabled=true,
  updated_at=now();

CREATE TABLE room_time_band_policies (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  time_band_id uuid NOT NULL REFERENCES schedule_time_bands(id) ON DELETE CASCADE,
  band_class varchar(30) NOT NULL DEFAULT 'NORMAL'
    CHECK (band_class IN ('PRIME','NORMAL','DEVELOPMENT','CALIBRATION')),
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id, time_band_id)
);

INSERT INTO room_time_band_policies(room_id,time_band_id,band_class,priority)
SELECT room.id, band.id,
       CASE band.code
         WHEN 'BAND_08_12' THEN 'PRIME'
         WHEN 'BAND_00_04' THEN 'DEVELOPMENT'
         WHEN 'BAND_04_08' THEN 'DEVELOPMENT'
         ELSE 'NORMAL'
       END,
       CASE band.code WHEN 'BAND_08_12' THEN 100 ELSE 50 END
FROM rooms room
CROSS JOIN schedule_time_bands band
WHERE room.enabled
ON CONFLICT(room_id,time_band_id) DO NOTHING;

CREATE TABLE room_coverage_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  timezone varchar(50) NOT NULL DEFAULT 'Asia/Shanghai',
  effective_from date,
  effective_to date,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, name, version),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX uq_room_coverage_template_active
  ON room_coverage_templates(room_id) WHERE status='ACTIVE';

CREATE TABLE room_coverage_template_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES room_coverage_templates(id) ON DELETE CASCADE,
  day_of_week smallint CHECK (day_of_week BETWEEN 0 AND 6),
  date_type varchar(20) NOT NULL DEFAULT 'ALL'
    CHECK (date_type IN ('ALL','WORKDAY','WEEKEND','HOLIDAY','SPECIAL')),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  block_minutes integer NOT NULL DEFAULT 240 CHECK (block_minutes BETWEEN 30 AND 300),
  required_anchor_count integer NOT NULL DEFAULT 1 CHECK (required_anchor_count BETWEEN 0 AND 4),
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX idx_coverage_template_slots_template
  ON room_coverage_template_slots(template_id, day_of_week, start_minute);

WITH inserted AS (
  INSERT INTO room_coverage_templates(room_id,name,version,status)
  SELECT room.id, room.name || ' 默认全天覆盖', 1, 'ACTIVE'
  FROM rooms room
  WHERE room.enabled
  ON CONFLICT(room_id,name,version) DO UPDATE SET status='ACTIVE', updated_at=now()
  RETURNING id
)
INSERT INTO room_coverage_template_slots(
  template_id,date_type,start_minute,end_minute,block_minutes,required_anchor_count,priority
)
SELECT id,'ALL',0,1440,240,1,50 FROM inserted
WHERE NOT EXISTS (
  SELECT 1 FROM room_coverage_template_slots slot WHERE slot.template_id=inserted.id
);

CREATE TABLE schedule_date_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  schedule_date date NOT NULL,
  date_type varchar(20) NOT NULL DEFAULT 'SPECIAL'
    CHECK (date_type IN ('WORKDAY','WEEKEND','HOLIDAY','SPECIAL','CLOSED')),
  coverage jsonb NOT NULL DEFAULT '[]',
  reason text,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, schedule_date)
);

CREATE TABLE anchor_scheduling_profiles (
  anchor_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  eligible_for_auto_schedule boolean NOT NULL DEFAULT true,
  target_monthly_minutes integer,
  min_monthly_minutes integer,
  max_monthly_minutes integer,
  preferred_time_band_codes text[] NOT NULL DEFAULT '{}',
  avoided_time_band_codes text[] NOT NULL DEFAULT '{}',
  consecutive_day_limit integer CHECK (consecutive_day_limit IS NULL OR consecutive_day_limit > 0),
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_monthly_minutes IS NULL OR min_monthly_minutes IS NULL OR max_monthly_minutes >= min_monthly_minutes)
);

INSERT INTO anchor_scheduling_profiles(anchor_id)
SELECT person.id
FROM people person
JOIN person_roles role ON role.person_id=person.id
  AND role.role='ANCHOR' AND role.enabled
ON CONFLICT(anchor_id) DO NOTHING;

CREATE TABLE anchor_room_eligibility (
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  eligible boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  reason text,
  confirmed_by uuid REFERENCES people(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(anchor_id, room_id)
);

INSERT INTO anchor_room_eligibility(anchor_id,room_id,eligible,priority,reason)
SELECT profile.anchor_id, room.id, true, 0, '系统迁移默认可排；管理员可按业务资格调整'
FROM anchor_scheduling_profiles profile
CROSS JOIN rooms room
WHERE room.enabled
ON CONFLICT(anchor_id,room_id) DO NOTHING;

CREATE TABLE anchor_availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  availability_type varchar(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (availability_type IN ('AVAILABLE','UNAVAILABLE','PREFERRED','AVOID')),
  effective_from date,
  effective_to date,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_anchor_availability_rules_lookup
  ON anchor_availability_rules(anchor_id, day_of_week, enabled);

CREATE TABLE anchor_availability_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  availability_type varchar(20) NOT NULL
    CHECK (availability_type IN ('AVAILABLE','UNAVAILABLE','LEAVE','PREFERRED','AVOID')),
  reason text,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_anchor_availability_exceptions_lookup
  ON anchor_availability_exceptions(anchor_id, starts_at, ends_at);

ALTER TABLE monthly_schedule_plans
  DROP CONSTRAINT IF EXISTS monthly_schedule_plans_status_check;
ALTER TABLE monthly_schedule_plans
  ADD CONSTRAINT monthly_schedule_plans_status_check
  CHECK (status IN (
    'DRAFT','GENERATING','REVIEWING','VALIDATED','PUBLISHED',
    'SUPERSEDED','CANCELLED','ARCHIVED','FAILED'
  ));
ALTER TABLE monthly_schedule_plans
  ADD COLUMN name varchar(160),
  ADD COLUMN strategy varchar(30) NOT NULL DEFAULT 'BALANCED'
    CHECK (strategy IN ('BUSINESS','BALANCED','CALIBRATION')),
  ADD COLUMN rule_set_id uuid REFERENCES schedule_rule_sets(id) ON DELETE SET NULL,
  ADD COLUMN cloned_from_plan_id uuid REFERENCES monthly_schedule_plans(id) ON DELETE SET NULL,
  ADD COLUMN supersedes_plan_id uuid REFERENCES monthly_schedule_plans(id) ON DELETE SET NULL,
  ADD COLUMN data_source_id uuid REFERENCES scheduling_data_sources(id) ON DELETE SET NULL,
  ADD COLUMN data_snapshot jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN data_snapshot_hash char(64),
  ADD COLUMN ability_snapshot jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN review_notes text,
  ADD COLUMN reviewed_by uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN publication_reason text;

UPDATE monthly_schedule_plans plan
SET name=COALESCE(name, to_char(schedule_month,'YYYY-MM') || ' 主播排班草案'),
    rule_set_id=COALESCE(rule_set_id, (SELECT id FROM schedule_rule_sets WHERE status='ACTIVE' LIMIT 1)),
    data_source_id=COALESCE(data_source_id, (SELECT id FROM scheduling_data_sources WHERE is_primary LIMIT 1)),
    strategy=COALESCE(strategy,'BALANCED')
WHERE name IS NULL OR rule_set_id IS NULL OR data_source_id IS NULL;

ALTER TABLE monthly_schedule_assignments
  ADD COLUMN locked boolean NOT NULL DEFAULT false,
  ADD COLUMN locked_reason text,
  ADD COLUMN locked_by uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN manual_override boolean NOT NULL DEFAULT false,
  ADD COLUMN original_anchor_id uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN change_reason text;
CREATE INDEX idx_monthly_assignments_plan_locked
  ON monthly_schedule_assignments(plan_id, locked, starts_at)
  WHERE status<>'CANCELLED';

CREATE TABLE schedule_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES monthly_schedule_plans(id) ON DELETE SET NULL,
  schedule_month date NOT NULL,
  run_type varchar(30) NOT NULL
    CHECK (run_type IN ('PRECHECK','FULL_GENERATION','UNLOCKED_REGENERATION','AUTO_REPAIR')),
  status varchar(20) NOT NULL
    CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  request_data jsonb NOT NULL DEFAULT '{}',
  result_summary jsonb NOT NULL DEFAULT '{}',
  error_message text,
  started_by uuid REFERENCES people(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX idx_schedule_generation_runs_month
  ON schedule_generation_runs(schedule_month, started_at DESC);

CREATE TABLE schedule_plan_change_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES monthly_schedule_plans(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES monthly_schedule_assignments(id) ON DELETE SET NULL,
  action varchar(50) NOT NULL,
  before_data jsonb,
  after_data jsonb,
  reason text,
  actor_id uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_plan_change_logs_plan
  ON schedule_plan_change_logs(plan_id, created_at DESC);

CREATE TABLE schedule_plan_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES monthly_schedule_plans(id) ON DELETE RESTRICT,
  replaced_plan_id uuid REFERENCES monthly_schedule_plans(id) ON DELETE SET NULL,
  validation_snapshot jsonb NOT NULL,
  soft_risk_reason text,
  published_by uuid REFERENCES people(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_plan_publications_plan
  ON schedule_plan_publications(plan_id, published_at DESC);

CREATE TABLE schedule_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type varchar(40) NOT NULL
    CHECK (import_type IN ('ANCHORS','ELIGIBILITY','AVAILABILITY','ABILITY','COVERAGE')),
  source_file_name varchar(255) NOT NULL,
  source_sha256 char(64),
  status varchar(20) NOT NULL
    CHECK (status IN ('UPLOADED','VALIDATING','READY','IMPORTING','COMPLETED','FAILED','ROLLED_BACK')),
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  validation_errors jsonb NOT NULL DEFAULT '[]',
  rollback_data jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TRIGGER trg_scheduling_data_sources_updated_at
  BEFORE UPDATE ON scheduling_data_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_schedule_rule_sets_updated_at
  BEFORE UPDATE ON schedule_rule_sets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_schedule_time_bands_updated_at
  BEFORE UPDATE ON schedule_time_bands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_room_time_band_policies_updated_at
  BEFORE UPDATE ON room_time_band_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_room_coverage_templates_updated_at
  BEFORE UPDATE ON room_coverage_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_room_coverage_template_slots_updated_at
  BEFORE UPDATE ON room_coverage_template_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_schedule_date_overrides_updated_at
  BEFORE UPDATE ON schedule_date_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_anchor_scheduling_profiles_updated_at
  BEFORE UPDATE ON anchor_scheduling_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_anchor_room_eligibility_updated_at
  BEFORE UPDATE ON anchor_room_eligibility
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_anchor_availability_rules_updated_at
  BEFORE UPDATE ON anchor_availability_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_anchor_availability_exceptions_updated_at
  BEFORE UPDATE ON anchor_availability_exceptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions(code,name,module,description) VALUES
  ('schedule.plan.generate','生成月度排班草案','SCHEDULE','执行预检并生成主播月度排班草案'),
  ('schedule.plan.edit','编辑月度排班草案','SCHEDULE','修改、锁定、交换和修复草案排班'),
  ('schedule.plan.review','审核月度排班草案','SCHEDULE','执行校验并提交审核意见'),
  ('schedule.plan.publish','发布月度正式排班','SCHEDULE','发布通过硬规则校验的正式排班'),
  ('schedule.rule.manage','管理自动排班规则','SCHEDULE','管理覆盖模板、时间带、策略和工时规则'),
  ('schedule.ability.manage','管理主播能力档案','SCHEDULE','维护主播在不同直播间的能力证据'),
  ('schedule.source.manage','管理排班数据源','SCHEDULE','查看并维护本地排班主数据源状态')
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
  AND permission.code IN (
    'schedule.plan.generate','schedule.plan.edit','schedule.plan.review',
    'schedule.plan.publish','schedule.rule.manage','schedule.ability.manage',
    'schedule.source.manage'
  )
ON CONFLICT(role_id,permission_id) DO UPDATE SET granted=true,updated_at=now();

INSERT INTO system_settings(key,category,value,value_type,description,editable) VALUES
  ('schedule.auto.full_time_target_monthly_hours','SCHEDULE','117','INTEGER','全职主播月度目标直播时长',true),
  ('schedule.auto.default_strategy','SCHEDULE','"BALANCED"','STRING','默认自动排班策略',true),
  ('schedule.auto.data_source_mode','SCHEDULE','"LOCAL_DATABASE"','STRING','自动排班数据源，固定为本地数据库',false)
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  editable=EXCLUDED.editable,
  updated_at=now();
