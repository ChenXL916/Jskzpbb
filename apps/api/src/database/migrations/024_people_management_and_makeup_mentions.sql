-- 预约群通知属于即时业务事件，不受首版定时排班通知 DDL 限制。
UPDATE schedule_notification_rules
SET effective_from=LEAST(effective_from, now()),
    description='主播、达人或编导预约成功后，立即通知化妆师群并@被预约化妆师',
    updated_at=now()
WHERE code='APPOINTMENT_BOOKED_GROUP';
