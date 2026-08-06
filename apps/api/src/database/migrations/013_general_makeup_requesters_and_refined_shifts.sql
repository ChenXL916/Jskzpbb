INSERT INTO roles(code, name, description, sort_order) VALUES
  ('TALENT', '达人', '查看化妆师可预约时间并为本人创建妆造预约', 15),
  ('DIRECTOR', '编导', '查看化妆师可预约时间并为本人创建妆造预约', 16)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order,
  enabled=true,
  updated_at=now();

INSERT INTO permissions(code, name, module, description) VALUES
  (
    'makeup.availability.view',
    '查看化妆师可预约时间',
    'APPOINTMENT',
    '仅展示化妆师公开状态和可预约时间，不展示服务对象详情'
  ),
  (
    'appointment.view.self',
    '查看本人预约',
    'APPOINTMENT',
    '查看本人发起或作为妆造对象的预约'
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
WHERE (
    role.code IN ('TALENT', 'DIRECTOR')
    AND permission.code IN (
      'makeup.availability.view',
      'appointment.create',
      'appointment.view.self'
    )
  )
  OR (
    role.code IN ('ANCHOR', 'FIELD_CONTROL', 'LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
    AND permission.code='appointment.view.self'
  )
  OR (
    role.code IN ('ADMIN', 'DEVELOPER')
    AND permission.code='makeup.availability.view'
  )
ON CONFLICT (role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();

ALTER TABLE makeup_appointments
  ADD COLUMN subject_type varchar(30),
  ADD COLUMN subject_person_id uuid REFERENCES people(id) ON DELETE RESTRICT;

UPDATE makeup_appointments
SET subject_type='ANCHOR',
    subject_person_id=anchor_id
WHERE subject_type IS NULL OR subject_person_id IS NULL;

ALTER TABLE makeup_appointments
  ALTER COLUMN subject_type SET NOT NULL,
  ALTER COLUMN subject_person_id SET NOT NULL,
  ALTER COLUMN anchor_id DROP NOT NULL,
  ALTER COLUMN live_session_id DROP NOT NULL,
  ALTER COLUMN room_id DROP NOT NULL,
  ADD CONSTRAINT makeup_appointments_subject_type_check
    CHECK (subject_type IN ('ANCHOR', 'TALENT', 'DIRECTOR'));

CREATE INDEX idx_appointments_subject_time
  ON makeup_appointments(subject_person_id, planned_start_at DESC);
CREATE INDEX idx_appointments_requester_time
  ON makeup_appointments(requester_id, planned_start_at DESC);

INSERT INTO shift_templates(
  name, start_time, end_time, duration_minutes, crosses_midnight,
  bookable, confirmation_required, segments
)
VALUES (
  '培训班', '10:00', '16:00', 360, false, false, false,
  '[{"startTime":"10:00:00","endTime":"16:00:00"}]'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  start_time=EXCLUDED.start_time,
  end_time=EXCLUDED.end_time,
  duration_minutes=EXCLUDED.duration_minutes,
  crosses_midnight=false,
  bookable=false,
  confirmation_required=false,
  segments=EXCLUDED.segments,
  enabled=true,
  updated_at=now();

INSERT INTO shift_templates(
  name, start_time, end_time, duration_minutes, crosses_midnight,
  bookable, confirmation_required, segments
)
VALUES (
  '行政班', '09:30', '18:30', 450, false, true, false,
  '[{"startTime":"09:30:00","endTime":"12:30:00"},{"startTime":"14:00:00","endTime":"18:30:00"}]'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  start_time=EXCLUDED.start_time,
  end_time=EXCLUDED.end_time,
  duration_minutes=EXCLUDED.duration_minutes,
  crosses_midnight=false,
  bookable=true,
  confirmation_required=false,
  segments=EXCLUDED.segments,
  enabled=true,
  updated_at=now();

INSERT INTO shift_templates(
  name, start_time, end_time, duration_minutes, crosses_midnight,
  bookable, confirmation_required, segments
)
VALUES
  (
    '自由班（7小时）', NULL, NULL, 420, false,
    true, true, '[]'::jsonb
  ),
  (
    '自由班（4小时）', NULL, NULL, 240, false,
    true, true, '[]'::jsonb
  )
ON CONFLICT (name) DO UPDATE SET
  start_time=NULL,
  end_time=NULL,
  duration_minutes=EXCLUDED.duration_minutes,
  crosses_midnight=false,
  bookable=true,
  confirmation_required=true,
  segments='[]'::jsonb,
  enabled=true,
  updated_at=now();

WITH alias_candidates AS (
  SELECT template.id AS shift_template_id,
         alias.value AS alias,
         lower(
           regexp_replace(alias.value, '[[:space:]（）()]', '', 'g')
         ) AS normalized_alias
  FROM shift_templates template
  JOIN LATERAL (
    SELECT unnest(
      CASE template.name
        WHEN '培训班' THEN ARRAY['培训班', '培训']
        WHEN '行政班' THEN ARRAY['行政班']
        WHEN '自由班（7小时）' THEN ARRAY[
          '自由班（7小时）', '自由班(7小时)', '自由（7小时）',
          '自由(7小时)', '自由7小时'
        ]
        WHEN '自由班（4小时）' THEN ARRAY[
          '自由班（4小时）', '自由班(4小时)', '自由（4小时）',
          '自由(4小时)', '自由4小时'
        ]
        ELSE ARRAY[]::text[]
      END
    ) AS value
  ) alias ON true
  WHERE template.name IN (
    '培训班', '行政班', '自由班（7小时）', '自由班（4小时）'
  )
), deduplicated_aliases AS (
  SELECT DISTINCT ON (normalized_alias)
         shift_template_id, alias, normalized_alias
  FROM alias_candidates
  ORDER BY normalized_alias, length(alias), alias
)
INSERT INTO shift_template_aliases(
  shift_template_id, alias, normalized_alias
)
SELECT shift_template_id, alias, normalized_alias
FROM deduplicated_aliases
ON CONFLICT (normalized_alias) DO UPDATE SET
  shift_template_id=EXCLUDED.shift_template_id,
  alias=EXCLUDED.alias,
  enabled=true,
  updated_at=now();
