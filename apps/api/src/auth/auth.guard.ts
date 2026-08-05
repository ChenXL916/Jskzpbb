import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PersonRole, CurrentUser } from '@jishi/contracts';
import { DatabaseService } from '../database/database.service';
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
  REQUIRED_ROLES_KEY
} from '../common/auth.decorators';
import { AuthenticatedRequest } from '../common/auth.types';
import { SessionService } from './session.service';

interface UserRow {
  id: string;
  person_id: string;
  display_name: string;
  avatar_url: string | null;
  login_allowed: boolean;
  disabled_at: Date | null;
  session_version: number;
  roles: PersonRole[];
  permissions: string[];
  room_ids: string[];
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly db: DatabaseService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.jishi_session as string | undefined;
    if (!token) throw new UnauthorizedException('请先使用系统账号登录');
    const payload = this.sessions.verify(token);

    const result = await this.db.query<UserRow>(
      `
        SELECT u.id, p.id AS person_id, p.display_name, p.avatar_url,
               p.login_allowed, u.disabled_at, u.session_version,
               ARRAY(
                 SELECT DISTINCT available.role_code
                 FROM (
                   SELECT r.code AS role_code
                   FROM user_role_bindings urb
                   JOIN roles r ON r.id=urb.role_id
                   WHERE urb.user_id=u.id AND urb.enabled AND r.enabled
                   UNION
                   SELECT legacy.role::text AS role_code
                   FROM person_roles legacy
                   WHERE legacy.person_id=p.id AND legacy.enabled
                 ) available
               ) AS roles,
               ARRAY(
                 SELECT DISTINCT permission.code
                 FROM permissions permission
                 JOIN role_permissions rp
                   ON rp.permission_id=permission.id AND rp.granted
                 JOIN roles permission_role
                   ON permission_role.id=rp.role_id AND permission_role.enabled
                 WHERE EXISTS (
                   SELECT 1 FROM user_role_bindings urb
                   WHERE urb.user_id=u.id AND urb.role_id=permission_role.id
                     AND urb.enabled
                 )
                 OR EXISTS (
                   SELECT 1 FROM person_roles legacy
                   WHERE legacy.person_id=p.id AND legacy.enabled
                     AND legacy.role::text=permission_role.code
                 )
               ) AS permissions,
               ARRAY(
                 SELECT DISTINCT scope.scope_id::text
                 FROM user_data_scopes scope
                 WHERE scope.user_id=u.id AND scope.scope_type='ROOM'
                   AND scope.can_view
               ) AS room_ids
        FROM users u
        JOIN people p ON p.id = u.person_id
        WHERE u.id = $1
      `,
      [payload.userId]
    );
    const row = result.rows[0];
    if (
      !row ||
      row.disabled_at ||
      !row.login_allowed ||
      row.session_version !== payload.sessionVersion
    ) {
      throw new ForbiddenException('账号尚未绑定权限或已停用');
    }

    const user: CurrentUser = {
      id: row.id,
      personId: row.person_id,
      displayName: row.display_name,
      roles: row.roles,
      permissions: row.permissions,
      roomIds: row.room_ids,
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {})
    };
    request.user = user;

    // Administrators and developers are platform-wide privileged roles. Keep
    // this check independent from the permission seed so a newly introduced
    // permission cannot accidentally hide or block a management capability.
    const hasGlobalAccess = user.roles.some((role) =>
      ['ADMIN', 'DEVELOPER'].includes(role)
    );

    const required = this.reflector.getAllAndOverride<PersonRole[]>(
      REQUIRED_ROLES_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (
      !hasGlobalAccess &&
      required?.length &&
      !required.some((role) => user.roles.includes(role))
    ) {
      throw new ForbiddenException('当前角色无权执行此操作');
    }
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (
      !hasGlobalAccess &&
      requiredPermissions?.length &&
      !requiredPermissions.every((permission) =>
        user.permissions?.includes(permission)
      )
    ) {
      throw new ForbiddenException('当前账号缺少执行此操作所需的功能权限');
    }
    const requiredAnyPermissions = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (
      !hasGlobalAccess &&
      requiredAnyPermissions?.length &&
      !requiredAnyPermissions.some((permission) =>
        user.permissions?.includes(permission)
      )
    ) {
      throw new ForbiddenException('当前账号缺少执行此操作所需的功能权限');
    }
    return true;
  }
}
