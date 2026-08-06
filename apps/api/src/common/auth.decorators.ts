import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PersonRole } from '@jishi/contracts';
import { AuthenticatedRequest } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const REQUIRED_ROLES_KEY = 'requiredRoles';
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const REQUIRED_ANY_PERMISSIONS_KEY = 'requiredAnyPermissions';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const Roles = (...roles: PersonRole[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);
export const Permissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
export const AnyPermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_ANY_PERMISSIONS_KEY, permissions);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user
);
