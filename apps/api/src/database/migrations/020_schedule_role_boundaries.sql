-- 排班权限正式分层：主管/管理员/开发者管理排班，业务人员只看本人排班。
UPDATE role_permissions mapping
SET granted=false, updated_at=now()
FROM roles role, permissions permission
WHERE mapping.role_id=role.id
  AND mapping.permission_id=permission.id
  AND role.code IN ('ANCHOR','TALENT','DIRECTOR','MAKEUP_ARTIST','FIELD_CONTROL')
  AND permission.code IN ('schedule.manage','schedule.view.all','schedule.view.room');

INSERT INTO role_permissions(role_id, permission_id, granted)
SELECT role.id, permission.id, true
FROM roles role
CROSS JOIN permissions permission
WHERE role.code IN ('ANCHOR','MAKEUP_ARTIST','FIELD_CONTROL')
  AND permission.code='schedule.view.self'
ON CONFLICT (role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();

INSERT INTO role_permissions(role_id, permission_id, granted)
SELECT role.id, permission.id, true
FROM roles role
CROSS JOIN permissions permission
WHERE role.code IN ('LIVE_SUPERVISOR','ADMIN','DEVELOPER')
  AND permission.code IN ('schedule.manage','schedule.view.all')
ON CONFLICT (role_id, permission_id) DO UPDATE SET
  granted=true,
  updated_at=now();

UPDATE role_permissions mapping
SET granted=false, updated_at=now()
FROM roles role, permissions permission
WHERE mapping.role_id=role.id
  AND mapping.permission_id=permission.id
  AND role.code IN ('TALENT','DIRECTOR')
  AND permission.code LIKE 'schedule.%';
