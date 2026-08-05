ALTER TABLE notifications
  ADD COLUMN idempotency_key varchar(255);

CREATE UNIQUE INDEX uq_notifications_idempotency_key
  ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
