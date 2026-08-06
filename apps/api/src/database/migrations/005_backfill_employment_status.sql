UPDATE staff_daily_schedules
SET employment_status=raw_data->>'状态',
    updated_at=now()
WHERE employment_status IS NULL
  AND NULLIF(raw_data->>'状态', '') IS NOT NULL;
