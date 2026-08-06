-- Release-blocker integrity fixes: deduplicate sync conflicts, preserve publish
-- history for legacy plans, and enforce field-control time exclusivity.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS chk_users_session_version_positive;

ALTER TABLE users
  ADD CONSTRAINT chk_users_session_version_positive
  CHECK (session_version > 0);

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY source_table_id, COALESCE(source_record_id, ''), conflict_type
           ORDER BY updated_at DESC, created_at DESC, id
         ) AS position
  FROM sync_conflicts
  WHERE status='OPEN'
)
UPDATE sync_conflicts conflict
SET status='RESOLVED', resolution='DUPLICATE_SUPERSEDED',
    resolved_at=now(), updated_at=now()
FROM ranked
WHERE conflict.id=ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_conflict_open_record_type
  ON sync_conflicts(
    source_table_id,
    COALESCE(source_record_id, ''),
    conflict_type
  )
  WHERE status='OPEN';

INSERT INTO schedule_plan_publications(
  plan_id, validation_snapshot, published_by, published_at
)
SELECT plan.id,
       COALESCE(plan.validation_summary, '{}'::jsonb),
       plan.created_by,
       COALESCE(plan.published_at, plan.updated_at)
FROM monthly_schedule_plans plan
WHERE plan.status='PUBLISHED'
  AND NOT EXISTS (
    SELECT 1 FROM schedule_plan_publications publication
    WHERE publication.plan_id=plan.id
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_plan_publication_plan
  ON schedule_plan_publications(plan_id);

ALTER TABLE room_field_controls
  DROP CONSTRAINT IF EXISTS ex_room_field_control_person_time;

ALTER TABLE room_field_controls
  ADD CONSTRAINT ex_room_field_control_person_time
  EXCLUDE USING gist (
    person_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (enabled);

CREATE INDEX IF NOT EXISTS idx_live_sessions_formal_range
  ON live_sessions(source_type, status, starts_at, ends_at);
