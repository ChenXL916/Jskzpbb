-- ADMIN and DEVELOPER are platform-wide roles. Backfill every current
-- permission and automatically grant future permissions when they are added.
INSERT INTO role_permissions(role_id, permission_id, granted)
SELECT role.id, permission.id, true
FROM roles role
CROSS JOIN permissions permission
WHERE role.code IN ('ADMIN', 'DEVELOPER')
ON CONFLICT(role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();

CREATE OR REPLACE FUNCTION grant_permission_to_privileged_roles()
RETURNS trigger AS $$
BEGIN
  INSERT INTO role_permissions(role_id, permission_id, granted)
  SELECT role.id, NEW.id, true
  FROM roles role
  WHERE role.code IN ('ADMIN', 'DEVELOPER')
  ON CONFLICT(role_id, permission_id) DO UPDATE SET
    granted=true,
    updated_at=now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_permissions_grant_privileged_roles ON permissions;
CREATE TRIGGER trg_permissions_grant_privileged_roles
  AFTER INSERT ON permissions
  FOR EACH ROW EXECUTE FUNCTION grant_permission_to_privileged_roles();
