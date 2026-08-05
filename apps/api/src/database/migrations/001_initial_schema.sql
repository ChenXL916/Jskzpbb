CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE person_role AS ENUM (
  'ANCHOR',
  'MAKEUP_ARTIST',
  'FIELD_CONTROL',
  'LIVE_SUPERVISOR',
  'ADMIN',
  'DEVELOPER'
);

CREATE TYPE parse_status AS ENUM ('SUCCESS', 'NEEDS_CONFIRMATION', 'FAILED');
CREATE TYPE sync_status AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');
CREATE TYPE appointment_status AS ENUM (
  'BOOKED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'RESCHEDULED',
  'PENDING_CONFIRMATION',
  'CONFLICT'
);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name varchar(100) NOT NULL,
  legal_name varchar(100),
  employee_no varchar(100),
  feishu_user_id varchar(128),
  feishu_open_id varchar(128),
  feishu_union_id varchar(128),
  avatar_url text,
  email varchar(255),
  phone varchar(50),
  employment_type varchar(30) NOT NULL DEFAULT 'FULL_TIME',
  employment_status varchar(30) NOT NULL DEFAULT 'ACTIVE',
  schedule_prefix varchar(10),
  login_allowed boolean NOT NULL DEFAULT true,
  booking_allowed boolean NOT NULL DEFAULT true,
  default_makeup_minutes integer CHECK (default_makeup_minutes IS NULL OR default_makeup_minutes > 0),
  aliases text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_people_employee_no
  ON people(employee_no) WHERE employee_no IS NOT NULL;
CREATE UNIQUE INDEX uq_people_feishu_user_id
  ON people(feishu_user_id) WHERE feishu_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_people_feishu_open_id
  ON people(feishu_open_id) WHERE feishu_open_id IS NOT NULL;
CREATE INDEX idx_people_display_name ON people(display_name);
CREATE INDEX idx_people_aliases ON people USING gin(aliases);

CREATE TABLE person_roles (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role person_role NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, role)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL UNIQUE REFERENCES people(id) ON DELETE RESTRICT,
  feishu_open_id varchar(128) NOT NULL UNIQUE,
  feishu_union_id varchar(128),
  access_token_encrypted bytea,
  refresh_token_encrypted bytea,
  token_expires_at timestamptz,
  refresh_expires_at timestamptz,
  last_login_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL UNIQUE,
  room_type varchar(30) NOT NULL DEFAULT 'LIVE_ROOM',
  location varchar(255),
  enabled boolean NOT NULL DEFAULT true,
  external_key varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_data_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type varchar(30) NOT NULL,
  scope_id uuid NOT NULL,
  can_view boolean NOT NULL DEFAULT true,
  can_manage boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_type, scope_id)
);
CREATE INDEX idx_user_data_scopes_user ON user_data_scopes(user_id);

CREATE TABLE shift_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(80) NOT NULL UNIQUE,
  start_time time,
  end_time time,
  duration_minutes integer,
  crosses_midnight boolean NOT NULL DEFAULT false,
  bookable boolean NOT NULL DEFAULT true,
  confirmation_required boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (start_time IS NOT NULL AND end_time IS NOT NULL)
    OR duration_minutes IS NOT NULL
    OR bookable = false
  )
);

CREATE TABLE staff_daily_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES people(id) ON DELETE RESTRICT,
  schedule_date date NOT NULL,
  role person_role NOT NULL,
  employment_status varchar(30),
  raw_person_name varchar(100) NOT NULL,
  raw_shift_value varchar(255) NOT NULL,
  shift_template_id uuid REFERENCES shift_templates(id) ON DELETE SET NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  is_rest boolean NOT NULL DEFAULT false,
  is_leave boolean NOT NULL DEFAULT false,
  is_bookable boolean NOT NULL DEFAULT false,
  parse_status parse_status NOT NULL,
  parse_message text,
  source_table_id varchar(128) NOT NULL,
  source_record_id varchar(128) NOT NULL,
  source_date_field_id varchar(128) NOT NULL,
  source_date_field_name varchar(128),
  source_version bigint,
  raw_data jsonb NOT NULL DEFAULT '{}',
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table_id, source_record_id, source_date_field_id),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_staff_daily_person_date ON staff_daily_schedules(person_id, schedule_date);
CREATE INDEX idx_staff_daily_date_role ON staff_daily_schedules(schedule_date, role);

CREATE TABLE live_slot_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_date date NOT NULL,
  room_id uuid REFERENCES rooms(id) ON DELETE RESTRICT,
  anchor_id uuid REFERENCES people(id) ON DELETE RESTRICT,
  raw_anchor_name varchar(100),
  employment_type varchar(30),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  raw_value text NOT NULL,
  schedule_type varchar(30) NOT NULL DEFAULT 'LIVE',
  exception_type varchar(30),
  extra_minutes integer NOT NULL DEFAULT 0,
  missing_minutes integer NOT NULL DEFAULT 0,
  makeup_required boolean NOT NULL DEFAULT true,
  parse_status parse_status NOT NULL,
  parse_message text,
  source_table_id varchar(128) NOT NULL,
  source_record_id varchar(128) NOT NULL,
  source_date_field_id varchar(128) NOT NULL,
  source_version bigint,
  raw_data jsonb NOT NULL DEFAULT '{}',
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table_id, source_record_id, source_date_field_id, starts_at, raw_anchor_name),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_live_slots_room_time ON live_slot_schedules(room_id, starts_at);
CREATE INDEX idx_live_slots_anchor_time ON live_slot_schedules(anchor_id, starts_at);

CREATE TABLE live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  schedule_type varchar(30) NOT NULL DEFAULT 'LIVE',
  makeup_required boolean NOT NULL DEFAULT true,
  status varchar(30) NOT NULL DEFAULT 'SCHEDULED',
  source_slot_ids uuid[] NOT NULL DEFAULT '{}',
  source_fingerprint varchar(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_live_sessions_anchor_time ON live_sessions(anchor_id, starts_at);
CREATE INDEX idx_live_sessions_room_time ON live_sessions(room_id, starts_at);

CREATE TABLE room_field_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source_schedule_id uuid REFERENCES staff_daily_schedules(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_room_controls_room_time ON room_field_controls(room_id, starts_at);
CREATE INDEX idx_room_controls_person_time ON room_field_controls(person_id, starts_at);

CREATE TABLE makeup_service_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL UNIQUE,
  default_minutes integer NOT NULL CHECK (default_minutes > 0),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes integer NOT NULL DEFAULT 15 CHECK (buffer_after_minutes >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE makeup_artist_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  makeup_artist_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  availability_type varchar(30) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source_schedule_id uuid REFERENCES staff_daily_schedules(id) ON DELETE SET NULL,
  bookable boolean NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_artist_availability_time
  ON makeup_artist_availability(makeup_artist_id, starts_at, ends_at);

CREATE TABLE makeup_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_no varchar(40) NOT NULL UNIQUE,
  status appointment_status NOT NULL DEFAULT 'BOOKED',
  makeup_date date NOT NULL,
  anchor_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  live_session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  requester_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  requester_role person_role NOT NULL,
  makeup_artist_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  service_type_id uuid NOT NULL REFERENCES makeup_service_types(id) ON DELETE RESTRICT,
  planned_start_at timestamptz NOT NULL,
  planned_end_at timestamptz NOT NULL,
  actual_start_at timestamptz,
  actual_end_at timestamptz,
  planned_minutes integer NOT NULL CHECK (planned_minutes > 0),
  location varchar(255) NOT NULL,
  reference_attachments jsonb NOT NULL DEFAULT '[]',
  completion_attachments jsonb NOT NULL DEFAULT '[]',
  exception_type varchar(50),
  exception_note text,
  original_requirement text,
  source_type varchar(30) NOT NULL DEFAULT 'APPLICATION',
  source_table_id varchar(128),
  source_record_id varchar(128),
  source_version bigint,
  data_version integer NOT NULL DEFAULT 1,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end_at > planned_start_at),
  CHECK (actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at)
);
CREATE INDEX idx_appointments_anchor_time ON makeup_appointments(anchor_id, planned_start_at);
CREATE INDEX idx_appointments_artist_time ON makeup_appointments(makeup_artist_id, planned_start_at);
CREATE UNIQUE INDEX uq_active_appointment_per_session
  ON makeup_appointments(anchor_id, live_session_id)
  WHERE status IN ('BOOKED', 'IN_PROGRESS');
ALTER TABLE makeup_appointments
  ADD CONSTRAINT no_overlapping_active_artist_appointments
  EXCLUDE USING gist (
    makeup_artist_id WITH =,
    tstzrange(planned_start_at, planned_end_at, '[)') WITH &&
  )
  WHERE (status IN ('BOOKED', 'IN_PROGRESS'));

CREATE TABLE appointment_status_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES makeup_appointments(id) ON DELETE CASCADE,
  from_status appointment_status,
  to_status appointment_status NOT NULL,
  actor_id uuid REFERENCES people(id) ON DELETE SET NULL,
  action varchar(50) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointment_logs_appointment ON appointment_status_logs(appointment_id, created_at);

CREATE TABLE feishu_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  app_token varchar(128) NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  status varchar(30) NOT NULL DEFAULT 'NOT_CONFIGURED',
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feishu_table_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES feishu_connections(id) ON DELETE CASCADE,
  table_id varchar(128) NOT NULL,
  table_name varchar(255) NOT NULL,
  view_id varchar(128),
  business_type varchar(50) NOT NULL,
  sync_direction varchar(30) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, table_id)
);

CREATE TABLE feishu_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_mapping_id uuid NOT NULL REFERENCES feishu_table_mappings(id) ON DELETE CASCADE,
  feishu_field_id varchar(128) NOT NULL,
  feishu_field_name varchar(255) NOT NULL,
  feishu_field_type integer NOT NULL,
  local_field_name varchar(100) NOT NULL,
  transform_rule jsonb NOT NULL DEFAULT '{}',
  required boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_mapping_id, feishu_field_id),
  UNIQUE (table_mapping_id, local_field_name)
);

CREATE TABLE external_record_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system varchar(30) NOT NULL DEFAULT 'FEISHU',
  source_table_id varchar(128) NOT NULL,
  source_record_id varchar(128) NOT NULL,
  local_resource_type varchar(50) NOT NULL,
  local_resource_id uuid,
  source_version bigint,
  content_hash varchar(64) NOT NULL,
  raw_data jsonb NOT NULL DEFAULT '{}',
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_table_id, source_record_id, local_resource_type)
);

CREATE TABLE sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type varchar(30) NOT NULL,
  table_mapping_id uuid REFERENCES feishu_table_mappings(id) ON DELETE SET NULL,
  status sync_status NOT NULL DEFAULT 'PENDING',
  cursor varchar(512),
  fetched_count integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status, created_at);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_mapping_id uuid REFERENCES feishu_table_mappings(id) ON DELETE SET NULL,
  source_table_id varchar(128) NOT NULL,
  source_record_id varchar(128),
  conflict_type varchar(50) NOT NULL,
  local_resource_type varchar(50),
  local_resource_id uuid,
  local_data jsonb,
  remote_data jsonb,
  difference_data jsonb,
  status varchar(30) NOT NULL DEFAULT 'OPEN',
  resolution varchar(30),
  resolved_by uuid REFERENCES people(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_conflicts_open ON sync_conflicts(status, created_at);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL UNIQUE,
  event_type varchar(255) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'RECEIVED',
  payload jsonb NOT NULL,
  retry_count integer NOT NULL DEFAULT 0,
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES people(id) ON DELETE SET NULL,
  action varchar(100) NOT NULL,
  resource_type varchar(50) NOT NULL,
  resource_id uuid,
  request_id varchar(100),
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_operation_logs_resource ON operation_logs(resource_type, resource_id, created_at);

CREATE TABLE idempotency_keys (
  key varchar(255) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation varchar(100) NOT NULL,
  request_hash varchar(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type varchar(100) NOT NULL,
  aggregate_type varchar(50) NOT NULL,
  aggregate_id uuid NOT NULL,
  recipient_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  channel varchar(30) NOT NULL DEFAULT 'FEISHU',
  idempotency_key varchar(255) NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX idx_outbox_pending ON notification_outbox(status, next_attempt_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'people', 'person_roles', 'users', 'rooms', 'shift_templates',
    'staff_daily_schedules', 'live_slot_schedules', 'live_sessions',
    'room_field_controls', 'makeup_service_types', 'makeup_artist_availability',
    'makeup_appointments', 'feishu_connections', 'feishu_table_mappings',
    'feishu_field_mappings', 'external_record_mappings', 'sync_jobs',
    'sync_conflicts'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END $$;

INSERT INTO makeup_service_types(code, name, default_minutes, buffer_after_minutes) VALUES
  ('FULL_LIVE_LOOK', '完整上播妆造', 60, 15),
  ('MAKEUP_ONLY', '仅化妆', 60, 15),
  ('HAIR_ONLY', '仅发型', 30, 15),
  ('TOUCH_UP', '补妆', 30, 10),
  ('SETTING', '定妆', 30, 10),
  ('TRIAL', '试妆', 90, 15),
  ('TRAINING', '妆造教学', 120, 15)
ON CONFLICT (code) DO NOTHING;

INSERT INTO shift_templates(name, start_time, end_time, crosses_midnight, bookable) VALUES
  ('00-08', '00:00', '08:00', false, true),
  ('08-17', '08:00', '17:00', false, true),
  ('12-20', '12:00', '20:00', false, true),
  ('20-05', '20:00', '05:00', true, true),
  ('休息', NULL, NULL, false, false)
ON CONFLICT (name) DO NOTHING;
