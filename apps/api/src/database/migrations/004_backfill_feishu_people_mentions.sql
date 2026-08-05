WITH mention_candidates AS (
  SELECT DISTINCT
    regexp_replace(s.raw_person_name, '^@', '') AS display_name,
    s.raw_data->'姓名'->0->>'token' AS feishu_open_id
  FROM staff_daily_schedules s
  WHERE s.raw_data->'姓名'->0->>'mentionType'='User'
    AND s.raw_data->'姓名'->0->>'token' LIKE 'ou\_%'
),
unique_people AS (
  SELECT p.display_name, min(p.id::text)::uuid AS person_id
  FROM people p
  WHERE p.archived_at IS NULL
  GROUP BY p.display_name
  HAVING count(*)=1
)
UPDATE people p
SET feishu_open_id=c.feishu_open_id,
    metadata=p.metadata || jsonb_build_object(
      'identityStatus', 'BOUND_FROM_FEISHU_MENTION',
      'matchBasis', 'FEISHU_MENTION_TOKEN'
    ),
    updated_at=now()
FROM mention_candidates c
JOIN unique_people u ON u.display_name=c.display_name
WHERE p.id=u.person_id
  AND p.feishu_open_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM people existing
    WHERE existing.feishu_open_id=c.feishu_open_id
  );
