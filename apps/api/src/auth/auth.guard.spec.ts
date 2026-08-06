import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  REQUIRED_ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
  REQUIRED_ROLES_KEY
} from '../common/auth.decorators';
import { DatabaseService } from '../database/database.service';
import { AuthGuard } from './auth.guard';
import { SessionService } from './session.service';

function contextWithRequest(request: Record<string, unknown>) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;
}

describe('AuthGuard permissions', () => {
  const request: Record<string, unknown> = {
    cookies: { jishi_session: 'signed-session' }
  };
  const session = {
    verify: jest.fn(() => ({ userId: 'user-1', sessionVersion: 1 }))
  } as unknown as SessionService;
  const db = {
    query: jest.fn(async () => ({
      rows: [
        {
          id: 'user-1',
          person_id: 'person-1',
          display_name: '测试场控',
          avatar_url: null,
          login_allowed: true,
          disabled_at: null,
          session_version: 1,
          roles: ['FIELD_CONTROL'],
          permissions: ['appointment.create_for_anchor'],
          room_ids: ['room-1']
        }
      ]
    }))
  } as unknown as DatabaseService;

  it('accepts one matching permission from an any-permission requirement', async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === REQUIRED_ANY_PERMISSIONS_KEY) {
          return ['appointment.create', 'appointment.create_for_anchor'];
        }
        if (key === REQUIRED_ROLES_KEY) return ['FIELD_CONTROL'];
        if (key === REQUIRED_PERMISSIONS_KEY) return undefined;
        return false;
      })
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector, session, db);

    await expect(
      guard.canActivate(contextWithRequest(request))
    ).resolves.toBe(true);
  });

  it('rejects an authenticated role when configured permission is missing', async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return ['people.manage'];
        if (key === REQUIRED_ROLES_KEY) return ['FIELD_CONTROL'];
        if (key === REQUIRED_ANY_PERMISSIONS_KEY) return undefined;
        return false;
      })
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector, session, db);

    await expect(
      guard.canActivate(contextWithRequest({ ...request }))
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['ADMIN', 'DEVELOPER']) (
    'keeps the %s role globally authorized when a new permission is not seeded yet',
    async (role) => {
      const privilegedDb = {
        query: jest.fn(async () => ({
          rows: [
            {
              id: 'user-1',
              person_id: 'person-1',
              display_name: 'Privileged user',
              avatar_url: null,
              login_allowed: true,
              disabled_at: null,
              session_version: 1,
              roles: [role],
              permissions: [],
              room_ids: []
            }
          ]
        }))
      } as unknown as DatabaseService;
      const reflector = {
        getAllAndOverride: jest.fn((key: string) => {
          if (key === REQUIRED_PERMISSIONS_KEY) return ['future.permission'];
          if (key === REQUIRED_ANY_PERMISSIONS_KEY) return ['another.permission'];
          if (key === REQUIRED_ROLES_KEY) return ['ANCHOR'];
          return false;
        })
      } as unknown as Reflector;
      const guard = new AuthGuard(reflector, session, privilegedDb);

      await expect(
        guard.canActivate(contextWithRequest({ ...request }))
      ).resolves.toBe(true);
    }
  );
});
