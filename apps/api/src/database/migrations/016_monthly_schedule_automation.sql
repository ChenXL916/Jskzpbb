-- 每月自动生成下月主播排班草案。仅生成草案，绝不自动发布。

INSERT INTO system_settings(
  key, category, value, value_type, description
)
VALUES
  (
    'schedule.auto.monthly_generation_enabled',
    'SCHEDULE', 'true'::jsonb, 'BOOLEAN',
    '是否启用每月自动生成主播排班草案（不会自动发布）'
  ),
  (
    'schedule.auto.monthly_generation_day_of_month',
    'SCHEDULE', '20'::jsonb, 'INTEGER',
    '每月自动生成草案的日期，范围1至28'
  ),
  (
    'schedule.auto.monthly_generation_hour',
    'SCHEDULE', '10'::jsonb, 'INTEGER',
    '自动生成草案的小时，Asia/Shanghai时区，范围0至23'
  ),
  (
    'schedule.auto.monthly_generation_minute',
    'SCHEDULE', '0'::jsonb, 'INTEGER',
    '自动生成草案的分钟，范围0至59'
  ),
  (
    'schedule.auto.monthly_generation_months_ahead',
    'SCHEDULE', '1'::jsonb, 'INTEGER',
    '生成未来第几个月的草案，范围1至3'
  )
ON CONFLICT (key) DO NOTHING;
