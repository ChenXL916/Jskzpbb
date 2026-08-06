CREATE TABLE feishu_write_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation varchar(50) NOT NULL,
  aggregate_type varchar(50) NOT NULL,
  aggregate_id uuid NOT NULL,
  idempotency_key varchar(255) NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX idx_feishu_write_outbox_pending
  ON feishu_write_outbox(status, next_attempt_at);
