import { Module } from '@nestjs/common';
import { AutoSchedulingController } from './auto-scheduling.controller';
import { AutoSchedulingService } from './auto-scheduling.service';
import { MonthlyScheduleAutomationService } from './monthly-schedule-automation.service';
import { SchedulingConfigurationController } from './scheduling-configuration.controller';
import { ScheduleImportService } from './schedule-import.service';
import { SchedulingImportController } from './scheduling-import.controller';

@Module({
  controllers: [
    AutoSchedulingController,
    SchedulingConfigurationController,
    SchedulingImportController
  ],
  providers: [
    AutoSchedulingService,
    MonthlyScheduleAutomationService,
    ScheduleImportService
  ]
})
export class AutoSchedulingModule {}
