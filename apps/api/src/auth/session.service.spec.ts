import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { SessionService } from './session.service';

describe('SessionService', () => {
  const service = new SessionService(
    new ConfigService({
      SESSION_SECRET: 'a-secure-test-secret-that-is-longer-than-32-characters'
    })
  );

  it('round-trips a signed session', () => {
    expect(service.verify(service.sign('user-1', 1))).toMatchObject({
      userId: 'user-1',
      sessionVersion: 1
    });
  });

  it('rejects a modified signature', () => {
    const token = service.sign('user-1', 1);
    expect(() => service.verify(`${token}x`)).toThrow(UnauthorizedException);
  });
});
