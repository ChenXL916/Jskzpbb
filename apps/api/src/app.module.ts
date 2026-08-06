import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppointmentModule } from './appointments/appointment.module';
import { AutoSchedulingModule } from './auto-scheduling/auto-scheduling.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { FeishuModule } from './feishu/feishu.module';
import { HealthController } from './health.controller';
import { OutboxModule } from './outbox/outbox.module';
import { ProductOperationsModule } from './product-operations/product-operations.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ScheduleParserModule } from './schedule-parser/schedule-parser.module';
import { WorkspaceModule } from './workspaces/workspace.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnvironment
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RealtimeModule,
    ScheduleParserModule,
    FeishuModule,
    AuthModule,
    AppointmentModule,
    AutoSchedulingModule,
    ProductOperationsModule,
    OutboxModule,
    WorkspaceModule
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }]
})
export class AppModule {}
