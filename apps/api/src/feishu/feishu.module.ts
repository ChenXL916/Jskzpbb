import { Global, Module } from '@nestjs/common';
import { FeishuClient } from './feishu.client';
import { FeishuController, FeishuWebhookController } from './feishu.controller';
import { FeishuMappingService } from './feishu-mapping.service';
import { FeishuSyncService } from './feishu-sync.service';
import { FeishuUserTokenService } from './feishu-user-token.service';
import { ScheduleParserModule } from '../schedule-parser/schedule-parser.module';

@Global()
@Module({
  imports: [ScheduleParserModule],
  controllers: [FeishuController, FeishuWebhookController],
  providers: [
    FeishuUserTokenService,
    FeishuClient,
    FeishuMappingService,
    FeishuSyncService
  ],
  exports: [FeishuClient, FeishuMappingService, FeishuSyncService]
})
export class FeishuModule {}
