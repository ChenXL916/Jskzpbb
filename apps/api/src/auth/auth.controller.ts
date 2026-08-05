import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  BadRequestException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import {
  IsString,
  Matches,
  MaxLength,
  MinLength
} from 'class-validator';
import { CurrentUser, Public } from '../common/auth.decorators';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { LoginRateLimitService } from './login-rate-limit.service';

class LocalLoginDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,64}$/, {
    message: '账号只能使用字母、数字、点、下划线或短横线'
  })
  username!: string;

  @IsString()
  @MinLength(8, { message: '密码至少需要8位' })
  @MaxLength(128, { message: '密码不能超过128位' })
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    private readonly loginRateLimit: LoginRateLimitService
  ) {}

  @Public()
  @Get('feishu')
  feishuLogin(@Res() response: Response): void {
    const state = randomBytes(24).toString('base64url');
    response.cookie('feishu_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
      maxAge: 5 * 60 * 1000
    });
    response.redirect(this.auth.authorizationUrl(state));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async localLogin(
    @Body() dto: LocalLoginDto,
    @Req() request: Request,
    @Res() response: Response
  ): Promise<void> {
    await this.loginRateLimit.assertAllowed(request.ip, dto.username);
    const result = await this.auth.loginWithPassword(
      dto.username,
      dto.password,
      request.ip
    );
    await this.loginRateLimit.reset(request.ip, dto.username);
    response.cookie(
      'jishi_session',
      this.sessions.sign(result.userId, result.sessionVersion),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
        maxAge: 8 * 60 * 60 * 1000
      }
    );
    response.status(200).json({
      displayName: result.displayName,
      roles: result.roles,
      landingPath: result.landingPath
    });
  }

  @Public()
  @Get('feishu/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() response: Response
  ): Promise<void> {
    const cookies = response.req.cookies as Record<string, string | undefined> | undefined;
    const cookieState = cookies?.feishu_oauth_state;
    if (!code || !state || !cookieState || state !== cookieState) {
      throw new BadRequestException('飞书登录回调校验失败');
    }
    const result = await this.auth.exchangeAndBind(code);
    response.clearCookie('feishu_oauth_state');
    if (result.pending) {
      response.redirect(`${this.config.getOrThrow<string>('WEB_ORIGIN')}/access-pending`);
      return;
    }
    response.cookie(
      'jishi_session',
      this.sessions.sign(result.userId, result.sessionVersion),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
        maxAge: 8 * 60 * 60 * 1000
      }
    );
    response.redirect(
      `${this.config.getOrThrow<string>('WEB_ORIGIN')}${result.landingPath}`
    );
  }

  @Get('me')
  me(@CurrentUser() user: CurrentUserType): CurrentUserType {
    return user;
  }

  @Public()
  @Get('status')
  status(): {
    mode: 'LOCAL';
    feishuLoginEnabled: boolean;
    feishuIntegrationConfigured: boolean;
  } {
    return {
      mode: 'LOCAL',
      feishuLoginEnabled: this.auth.isFeishuLoginEnabled(),
      feishuIntegrationConfigured: this.auth.isConfigured()
    };
  }

  @Get('logout')
  async logout(
    @CurrentUser() user: CurrentUserType,
    @Res() response: Response
  ): Promise<void> {
    await this.auth.revokeSessions(user.id);
    response.clearCookie('jishi_session');
    response.redirect(this.config.getOrThrow<string>('WEB_ORIGIN'));
  }

  @Post('logout')
  @HttpCode(204)
  async logoutPost(
    @CurrentUser() user: CurrentUserType,
    @Res() response: Response
  ): Promise<void> {
    await this.auth.revokeSessions(user.id);
    response.clearCookie('jishi_session');
    response.status(204).send();
  }
}
