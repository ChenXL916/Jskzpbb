import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { AppointmentController } from './appointment.controller';
import { AppointmentService } from './appointment.service';
import { AppointmentStateMachineService } from './appointment-state-machine.service';
import { RedisLockService } from './redis-lock.service';

@Module({
  imports: [OutboxModule],
  controllers: [AppointmentController],
  providers: [
    AppointmentService,
    AppointmentStateMachineService,
    RedisLockService
  ],
  exports: [AppointmentService]
})
export class AppointmentModule {}
