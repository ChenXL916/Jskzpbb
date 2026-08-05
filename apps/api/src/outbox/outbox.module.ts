import { Module } from '@nestjs/common';
import { GroupNotificationDeliveryService } from './group-notification-delivery.service';
import { OutboxWorkerService } from './outbox-worker.service';
import { ScheduleNotificationController } from './schedule-notification.controller';
import { ScheduleNotificationService } from './schedule-notification.service';

@Module({
  controllers: [ScheduleNotificationController],
  providers: [
    GroupNotificationDeliveryService,
    ScheduleNotificationService,
    OutboxWorkerService
  ],
  exports: [ScheduleNotificationService]
})
export class OutboxModule {}
