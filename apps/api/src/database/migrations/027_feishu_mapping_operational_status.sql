ALTER TABLE feishu_table_mappings
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

UPDATE schedule_notification_rules
SET weekday=4,
    send_time='17:00',
    description='每周四17:00提醒排班负责人开始安排下一周直播场次和人员班次',
    updated_at=now()
WHERE code='SCHEDULE_START_REMINDER';

UPDATE schedule_notification_rules
SET weekday=6,
    send_time='18:00',
    description='每周六18:00把系统中下一周的有效直播排班汇总发送到主播群',
    updated_at=now()
WHERE code='SCHEDULE_PUBLISH';
