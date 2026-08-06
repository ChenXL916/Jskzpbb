ALTER TABLE shift_templates
  ADD COLUMN IF NOT EXISTS segments jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS staff_schedule_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES staff_daily_schedules(id) ON DELETE CASCADE,
  segment_index integer NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  bookable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, segment_index),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_staff_schedule_segments_time
  ON staff_schedule_segments(schedule_id, starts_at, ends_at);

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
  name, duration_minutes, crosses_midnight, bookable,
  confirmation_required, segments
)
VALUES ('自由班', 480, false, true, true, '[]'::jsonb)
ON CONFLICT (name) DO UPDATE SET
  start_time=NULL,
  end_time=NULL,
  duration_minutes=480,
  crosses_midnight=false,
  bookable=true,
  confirmation_required=true,
  segments='[]'::jsonb,
  enabled=true,
  updated_at=now();

UPDATE staff_daily_schedules s
SET shift_template_id=t.id,
    starts_at=(s.schedule_date + time '09:30') AT TIME ZONE 'Asia/Shanghai',
    ends_at=(s.schedule_date + time '18:30') AT TIME ZONE 'Asia/Shanghai',
    is_rest=false,
    is_bookable=true,
    parse_status='SUCCESS',
    parse_message=NULL,
    updated_at=now()
FROM shift_templates t
WHERE t.name='行政班'
  AND regexp_replace(s.raw_shift_value, '\s+', '', 'g')='行政班';

INSERT INTO staff_schedule_segments(
  schedule_id, segment_index, starts_at, ends_at, bookable
)
SELECT s.id, segment.segment_index,
       (s.schedule_date + segment.starts_at) AT TIME ZONE 'Asia/Shanghai',
       (s.schedule_date + segment.ends_at) AT TIME ZONE 'Asia/Shanghai',
       true
FROM staff_daily_schedules s
CROSS JOIN (
  VALUES
    (0, time '09:30', time '12:30'),
    (1, time '14:00', time '18:30')
) AS segment(segment_index, starts_at, ends_at)
WHERE regexp_replace(s.raw_shift_value, '\s+', '', 'g')='行政班'
ON CONFLICT (schedule_id, segment_index) DO UPDATE SET
  starts_at=EXCLUDED.starts_at,
  ends_at=EXCLUDED.ends_at,
  bookable=true,
  updated_at=now();

UPDATE staff_daily_schedules s
SET shift_template_id=t.id,
    starts_at=NULL,
    ends_at=NULL,
    is_rest=false,
    is_bookable=false,
    parse_status='NEEDS_CONFIRMATION',
    parse_message='自由班为8小时弹性班，需补充开始时间后才可预约',
    updated_at=now()
FROM shift_templates t
WHERE t.name='自由班'
  AND regexp_replace(s.raw_shift_value, '[\s（）()]', '', 'g')
      IN ('自由班', '自由8小时');
