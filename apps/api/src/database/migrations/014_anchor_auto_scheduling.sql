-- 月度主播自动排班：能力评分、可编辑草案、校验后发布。

CREATE TABLE anchor_performance_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL,
  sample_hours numeric(8,2) NOT NULL CHECK (sample_hours >= 0),
  capability_score numeric(8,3) NOT NULL CHECK (capability_score > 0),
  confidence_grade varchar(1) NOT NULL CHECK (confidence_grade IN ('A','B','C')),
  source_rank integer NOT NULL CHECK (source_rank > 0),
  source_document varchar(255) NOT NULL,
  scoring_method varchar(80) NOT NULL DEFAULT 'CORRECTED_GEOMETRIC_MEAN',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(anchor_id, room_id, period_start, period_end, source_document),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_anchor_performance_room_period
  ON anchor_performance_scores(room_id, period_end DESC, capability_score DESC);

CREATE TABLE monthly_schedule_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_month date NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','CANCELLED','ARCHIVED')),
  rules_snapshot jsonb NOT NULL,
  generation_summary jsonb NOT NULL DEFAULT '{}',
  validation_summary jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
  published_by uuid REFERENCES people(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_trunc('month', schedule_month)::date = schedule_month)
);
CREATE INDEX idx_monthly_schedule_plans_month
  ON monthly_schedule_plans(schedule_month, created_at DESC);

CREATE TABLE monthly_schedule_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES monthly_schedule_plans(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  required_anchor_count integer NOT NULL DEFAULT 1
    CHECK (required_anchor_count BETWEEN 1 AND 4),
  priority integer NOT NULL DEFAULT 0,
  status varchar(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FILLED','PARTIAL','UNFILLED','PUBLISHED','CANCELLED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at <= starts_at + interval '5 hours')
);
CREATE INDEX idx_monthly_schedule_slots_plan_time
  ON monthly_schedule_slots(plan_id, starts_at, room_id);
ALTER TABLE monthly_schedule_slots
  ADD CONSTRAINT no_overlapping_plan_room_slots
  EXCLUDE USING gist (
    plan_id WITH =,
    room_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED');

CREATE TABLE monthly_schedule_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES monthly_schedule_plans(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL REFERENCES monthly_schedule_slots(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  performance_score_id uuid REFERENCES anchor_performance_scores(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','MODIFIED','PUBLISHED','CANCELLED')),
  preference_tier varchar(30) NOT NULL DEFAULT 'NEUTRAL'
    CHECK (preference_tier IN ('STRONG','NEUTRAL','WEAK','UNSCORED')),
  score numeric(12,3) NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1,
  published_session_id uuid REFERENCES live_sessions(id) ON DELETE SET NULL,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at <= starts_at + interval '5 hours'),
  UNIQUE(slot_id, anchor_id)
);
CREATE INDEX idx_monthly_assignments_plan_time
  ON monthly_schedule_assignments(plan_id, starts_at, room_id);
CREATE INDEX idx_monthly_assignments_anchor_time
  ON monthly_schedule_assignments(anchor_id, starts_at, ends_at);

ALTER TABLE monthly_schedule_assignments
  ADD CONSTRAINT no_overlapping_plan_anchor_assignments
  EXCLUDE USING gist (
    plan_id WITH =,
    anchor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('DRAFT','MODIFIED','PUBLISHED'));

CREATE TABLE schedule_plan_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES monthly_schedule_plans(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES monthly_schedule_assignments(id) ON DELETE CASCADE,
  anchor_id uuid REFERENCES people(id) ON DELETE SET NULL,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  rule_code varchar(80) NOT NULL,
  severity varchar(20) NOT NULL CHECK (severity IN ('ERROR','WARNING','INFO')),
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_plan_violations_plan
  ON schedule_plan_violations(plan_id, severity, created_at);

CREATE TRIGGER trg_anchor_performance_scores_updated_at
  BEFORE UPDATE ON anchor_performance_scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_monthly_schedule_plans_updated_at
  BEFORE UPDATE ON monthly_schedule_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_monthly_schedule_slots_updated_at
  BEFORE UPDATE ON monthly_schedule_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_monthly_schedule_assignments_updated_at
  BEFORE UPDATE ON monthly_schedule_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 现有主播主数据的 employment_type 曾全部默认成 FULL_TIME。
-- 仅当飞书小时排班对同一人给出唯一、非空的 Q/J 解析结果时才安全回填。
WITH inferred AS (
  SELECT anchor_id, min(employment_type) AS employment_type
  FROM live_slot_schedules
  WHERE anchor_id IS NOT NULL
    AND employment_type IN ('FULL_TIME','PART_TIME')
  GROUP BY anchor_id
  HAVING count(DISTINCT employment_type)=1
)
UPDATE people person
SET employment_type=inferred.employment_type,
    metadata=person.metadata || jsonb_build_object(
      'employment_type_source','FEISHU_LIVE_SLOT_PREFIX',
      'employment_type_verified_at',now()
    ),
    updated_at=now()
FROM inferred
WHERE person.id=inferred.anchor_id;

UPDATE people person
SET employment_type='UNKNOWN',
    metadata=person.metadata || jsonb_build_object(
      'employment_type_source','UNCONFIRMED',
      'employment_type_review_required',true
    ),
    updated_at=now()
WHERE EXISTS (
    SELECT 1 FROM person_roles role
    WHERE role.person_id=person.id AND role.role='ANCHOR' AND role.enabled
  )
  AND NOT EXISTS (
    SELECT 1 FROM live_slot_schedules slot
    WHERE slot.anchor_id=person.id
      AND slot.employment_type IN ('FULL_TIME','PART_TIME')
  )
  AND COALESCE((person.metadata->>'employment_type_confirmed')::boolean,false)=false;

-- 7月公平诊断报告：按直播间、统计周期和置信等级保存。
-- C级（少于30小时）只参与中性参考，不自动贴“强/弱”标签。
WITH score_data(room_name, anchor_name, hours, score, confidence, rank_no, document_name) AS (
  VALUES
    ('柏瑞美-散粉','儿儿',75,105.5,'A',1,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','盟菲',31,102.3,'B',2,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','梦丽',18,101.8,'C',3,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','嘉怡',52,99.8,'B',4,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','陈莹',121,99.6,'A',5,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','兰婷',17,99.6,'C',6,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','朱晴',29,98.8,'C',7,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','菜菜',76,98.5,'A',8,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','若凡',22,98.0,'C',9,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','月丽',109,97.9,'A',10,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-散粉','李昕',109,97.8,'A',11,'【柏瑞美】散粉7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','缨慈',39,103.7,'B',1,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','琼文',127,102.7,'A',2,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','莹莹',25,101.4,'C',3,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','嘉怡',3,100.2,'C',4,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','儿儿',8,100.1,'C',5,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','金蓉',2,99.8,'C',6,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','鑫鑫',84,99.7,'A',7,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','喻卢琴',20,99.5,'C',8,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','思思',149,99.4,'A',9,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','江珞',6,99.3,'C',10,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','林斯淇',81,98.0,'A',11,'【柏瑞美】妆前乳7月主播数据公平诊断.docx'),
    ('柏瑞美-妆前乳','小悦',149,97.7,'A',12,'【柏瑞美】妆前乳7月主播数据公平诊断.docx')
)
INSERT INTO anchor_performance_scores(
  anchor_id, room_id, period_start, period_end, sample_hours,
  capability_score, confidence_grade, source_rank, source_document,
  metadata
)
SELECT person.id, room.id, DATE '2026-07-01', DATE '2026-07-29',
       score_data.hours, score_data.score, score_data.confidence,
       score_data.rank_no, score_data.document_name,
       jsonb_build_object(
         'report_scope', 'single_anchor_hours',
         'source_prefix', CASE person.employment_type
           WHEN 'FULL_TIME' THEN 'Q' ELSE 'J' END,
         'confidence_rule', 'A>=60h; B=30-59h; C<30h'
       )
FROM score_data
JOIN rooms room ON room.name=score_data.room_name
JOIN people person ON person.display_name=score_data.anchor_name
JOIN person_roles role ON role.person_id=person.id
  AND role.role='ANCHOR' AND role.enabled
ON CONFLICT(anchor_id, room_id, period_start, period_end, source_document)
DO UPDATE SET
  sample_hours=EXCLUDED.sample_hours,
  capability_score=EXCLUDED.capability_score,
  confidence_grade=EXCLUDED.confidence_grade,
  source_rank=EXCLUDED.source_rank,
  metadata=EXCLUDED.metadata,
  updated_at=now();

INSERT INTO system_settings(key, category, value, value_type, description) VALUES
  ('schedule.auto.max_session_hours','SCHEDULE','5','INTEGER','主播单次直播最长小时数'),
  ('schedule.auto.min_rest_hours','SCHEDULE','8','INTEGER','主播跨班次最短休息小时数'),
  ('schedule.auto.full_time_min_monthly_hours','SCHEDULE','104','INTEGER','全职主播月直播最低目标小时数'),
  ('schedule.auto.full_time_max_monthly_hours','SCHEDULE','130','INTEGER','全职主播月直播最高小时数'),
  ('schedule.auto.block_hours','SCHEDULE','4','INTEGER','自动排班默认连续直播块小时数'),
  ('schedule.auto.morning_start','SCHEDULE','"08:00"','STRING','能力强主播优先早班的开始时间'),
  ('schedule.auto.morning_end','SCHEDULE','"12:00"','STRING','能力强主播优先早班的结束时间'),
  ('schedule.auto.overnight_start','SCHEDULE','"00:00"','STRING','能力待提升主播优先凌晨的开始时间'),
  ('schedule.auto.overnight_end','SCHEDULE','"06:00"','STRING','能力待提升主播优先凌晨的结束时间'),
  ('schedule.auto.strong_score_threshold','SCHEDULE','102','DECIMAL','A/B置信主播早班优先阈值'),
  ('schedule.auto.weak_score_threshold','SCHEDULE','98','DECIMAL','A/B置信主播凌晨优先阈值')
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  updated_at=now();

INSERT INTO permissions(code, name, module, description)
VALUES (
  'schedule.auto_generate',
  '生成并发布月度主播排班',
  'SCHEDULE',
  '依据工时、休息、能力评分和现有排班生成可编辑月度草案'
)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  module=EXCLUDED.module,
  description=EXCLUDED.description,
  updated_at=now();

INSERT INTO role_permissions(role_id, permission_id, granted)
SELECT role.id, permission.id, true
FROM roles role
CROSS JOIN permissions permission
WHERE role.code IN ('LIVE_SUPERVISOR','ADMIN','DEVELOPER')
  AND permission.code='schedule.auto_generate'
ON CONFLICT(role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();
