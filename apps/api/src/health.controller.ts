import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from './common/auth.decorators';
import { DatabaseService } from './database/database.service';
import { FeishuClient } from './feishu/feishu.client';

@Controller()
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly feishu: FeishuClient
  ) {}

  @Public()
  @Get('health')
  async health() {
    return {
      status: (await this.db.health()) ? 'ok' : 'degraded',
      timezone: this.config.get<string>('TZ'),
      feishuConfigured: this.feishu.isConfigured(),
      timestamp: new Date().toISOString()
    };
  }
}
