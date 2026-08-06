ALTER TABLE users
  ALTER COLUMN feishu_open_id DROP NOT NULL,
  ADD COLUMN username varchar(64),
  ADD COLUMN password_hash text,
  ADD COLUMN auth_source varchar(20) NOT NULL DEFAULT 'FEISHU',
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_failed_login_at timestamptz,
  ADD COLUMN locked_until timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_auth_source_check
    CHECK (auth_source IN ('LOCAL', 'FEISHU')),
  ADD CONSTRAINT users_failed_login_count_check
    CHECK (failed_login_count >= 0),
  ADD CONSTRAINT users_username_format_check
    CHECK (
      username IS NULL
      OR username ~ '^[A-Za-z0-9._-]{3,64}$'
    );

CREATE UNIQUE INDEX uq_users_username_ci
  ON users(lower(username))
  WHERE username IS NOT NULL;

CREATE INDEX idx_users_local_login
  ON users(lower(username), locked_until)
  WHERE username IS NOT NULL AND password_hash IS NOT NULL;
