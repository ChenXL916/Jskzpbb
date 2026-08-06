-- 经营优先自动排班：能力必须按“主播×直播间”保存，兼职不再设置平均工时目标。
ALTER TABLE anchor_performance_scores
  ADD COLUMN ability_level varchar(20) NOT NULL DEFAULT 'STABLE'
    CHECK (ability_level IN ('ELITE','STRONG','STABLE','DEVELOPING','OBSERVATION')),
  ADD COLUMN room_fit_score numeric(6,2) NOT NULL DEFAULT 50
    CHECK (room_fit_score BETWEEN 0 AND 100),
  ADD COLUMN morning_priority boolean NOT NULL DEFAULT false,
  ADD COLUMN development_priority boolean NOT NULL DEFAULT false;

UPDATE anchor_performance_scores
SET ability_level=CASE
      WHEN confidence_grade IN ('A','B') AND capability_score >= 103.5 THEN 'ELITE'
      WHEN confidence_grade IN ('A','B') AND capability_score >= 102 THEN 'STRONG'
      WHEN capability_score < 98 THEN 'DEVELOPING'
      WHEN confidence_grade='C' THEN 'OBSERVATION'
      ELSE 'STABLE'
    END,
    room_fit_score=CASE confidence_grade
      WHEN 'A' THEN 100
      WHEN 'B' THEN 85
      ELSE 60
    END,
    morning_priority=(confidence_grade IN ('A','B') AND capability_score >= 102),
    development_priority=(capability_score < 98),
    updated_at=now();

ALTER TABLE anchor_room_eligibility
  ADD COLUMN permission_source varchar(30) NOT NULL DEFAULT 'LEGACY_REVIEW_REQUIRED'
    CHECK (permission_source IN ('REPORT_INFERRED','ADMIN_GRANTED','LEGACY_REVIEW_REQUIRED')),
  ADD COLUMN cross_room_authorized boolean NOT NULL DEFAULT false;

UPDATE anchor_room_eligibility
SET permission_source=CASE
      WHEN confirmed_by IS NOT NULL THEN 'ADMIN_GRANTED'
      ELSE 'LEGACY_REVIEW_REQUIRED'
    END,
    cross_room_authorized=(confirmed_by IS NOT NULL),
    updated_at=now();

-- 对已有能力报告覆盖的主播重新推导直播间资格；管理员明确确认过的记录不覆盖。
UPDATE anchor_room_eligibility eligibility
SET eligible=false,
    permission_source='REPORT_INFERRED',
    cross_room_authorized=false,
    reason='按主播直播间能力报告重新推导；未授权跨直播间',
    updated_at=now()
WHERE eligibility.confirmed_by IS NULL
  AND EXISTS (
    SELECT 1 FROM anchor_performance_scores score
    WHERE score.anchor_id=eligibility.anchor_id
  );

UPDATE anchor_room_eligibility eligibility
SET eligible=true,
    permission_source='REPORT_INFERRED',
    reason='该主播在目标直播间存在独立能力报告',
    updated_at=now()
WHERE eligibility.confirmed_by IS NULL
  AND EXISTS (
    SELECT 1 FROM anchor_performance_scores score
    WHERE score.anchor_id=eligibility.anchor_id
      AND score.room_id=eligibility.room_id
  );

-- 散粉主播允许排散粉和妆前乳；妆前乳主播不会据此反向取得散粉资格。
WITH powder_anchors AS (
  SELECT DISTINCT score.anchor_id
  FROM anchor_performance_scores score
  JOIN rooms source_room ON source_room.id=score.room_id
  WHERE source_room.name='柏瑞美-散粉'
)
UPDATE anchor_room_eligibility eligibility
SET eligible=true,
    permission_source='REPORT_INFERRED',
    cross_room_authorized=true,
    reason='散粉主播业务规则授权：可排散粉及妆前乳直播间',
    updated_at=now()
FROM powder_anchors, rooms target_room
WHERE eligibility.anchor_id=powder_anchors.anchor_id
  AND eligibility.room_id=target_room.id
  AND eligibility.confirmed_by IS NULL
  AND (target_room.name ILIKE '%散粉%' OR target_room.name ILIKE '%妆前乳%');

ALTER TABLE schedule_rule_sets
  ADD COLUMN business_priority integer NOT NULL DEFAULT 90 CHECK (business_priority BETWEEN 0 AND 100),
  ADD COLUMN ability_weight integer NOT NULL DEFAULT 80 CHECK (ability_weight BETWEEN 0 AND 100),
  ADD COLUMN full_time_priority integer NOT NULL DEFAULT 80 CHECK (full_time_priority BETWEEN 0 AND 100),
  ADD COLUMN part_time_fairness integer NOT NULL DEFAULT 10 CHECK (part_time_fairness BETWEEN 0 AND 100),
  ADD COLUMN development_ratio integer NOT NULL DEFAULT 25 CHECK (development_ratio BETWEEN 0 AND 100),
  ADD COLUMN golden_time_protection integer NOT NULL DEFAULT 80 CHECK (golden_time_protection BETWEEN 0 AND 100),
  ADD COLUMN max_consecutive_overnight_sessions integer NOT NULL DEFAULT 3
    CHECK (max_consecutive_overnight_sessions BETWEEN 1 AND 3);

UPDATE schedule_rule_sets
SET strategy_weights='{
  "objective":"MAXIMIZE_OPERATING_RESULT",
  "ability":40,
  "roomFit":25,
  "personType":15,
  "timeFit":15,
  "loadBalance":5,
  "fullTimeWeight":1.2,
  "elitePartTimeWeight":1.1,
  "normalPartTimeWeight":0.8,
  "observationPartTimeWeight":0.5
}'::jsonb,
    business_priority=90,
    ability_weight=80,
    full_time_priority=80,
    part_time_fairness=10,
    development_ratio=25,
    golden_time_protection=80,
    max_consecutive_overnight_sessions=3,
    updated_at=now()
WHERE status='ACTIVE';

INSERT INTO system_settings(key,category,value,value_type,description,editable) VALUES
  ('schedule.auto.business_priority','SCHEDULE','90','INTEGER','经营结果优先程度',true),
  ('schedule.auto.ability_weight','SCHEDULE','80','INTEGER','主播能力权重',true),
  ('schedule.auto.full_time_priority','SCHEDULE','80','INTEGER','全职主播优先程度',true),
  ('schedule.auto.part_time_fairness','SCHEDULE','10','INTEGER','兼职公平权重；默认不追求平均',true),
  ('schedule.auto.development_ratio','SCHEDULE','25','INTEGER','培养主播时段比例',true),
  ('schedule.auto.golden_time_protection','SCHEDULE','80','INTEGER','黄金时段保护程度',true),
  ('schedule.auto.max_consecutive_overnight_sessions','SCHEDULE','3','INTEGER','连续凌晨直播次数上限',true),
  ('schedule.auto.default_strategy','SCHEDULE','"BUSINESS"','STRING','默认自动排班策略为经营优先',true)
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  editable=EXCLUDED.editable,
  updated_at=now();
