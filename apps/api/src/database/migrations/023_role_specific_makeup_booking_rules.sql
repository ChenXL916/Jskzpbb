-- New appointments follow two explicit policies:
-- 1. Anchor makeup starts 60 minutes before the linked live session.
-- 2. Talent/director general makeup occupies 30-40 minutes.
UPDATE makeup_service_types
SET default_minutes=40,
    buffer_after_minutes=20,
    updated_at=now()
WHERE code='FULL_LIVE_LOOK';

UPDATE makeup_service_types
SET default_minutes=40,
    updated_at=now()
WHERE code='MAKEUP_ONLY';

INSERT INTO makeup_service_types(
  code, name, default_minutes, buffer_before_minutes,
  buffer_after_minutes, enabled
) VALUES (
  'GENERAL_MAKEUP', '日常妆造', 40, 0, 0, true
)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  default_minutes=EXCLUDED.default_minutes,
  buffer_before_minutes=EXCLUDED.buffer_before_minutes,
  buffer_after_minutes=EXCLUDED.buffer_after_minutes,
  enabled=true,
  updated_at=now();

INSERT INTO system_settings(
  key, category, value, value_type, description, editable
) VALUES (
  'booking.anchor_lead_minutes', 'BOOKING', '60', 'INTEGER',
  '主播妆造开始时间相对开播时间的提前量（分钟）', true
)
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  value_type=EXCLUDED.value_type,
  description=EXCLUDED.description,
  editable=EXCLUDED.editable,
  updated_at=now();

UPDATE system_settings
SET value='40', updated_at=now()
WHERE key='booking.full_makeup_minutes';

UPDATE system_settings
SET value='20', updated_at=now()
WHERE key='booking.live_buffer_minutes';
