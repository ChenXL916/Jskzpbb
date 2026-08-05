import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { LoginRateLimitService } from './login-rate-limit.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    LoginRateLimitService
  ],
  exports: [PasswordService, SessionService]
})
export class AuthModule {}
