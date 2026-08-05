import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  AdminController,
  ControlRoomController,
  MakeupArtistPublicController,
  MakeupArtistTaskController,
  MeController
} from './workspace.controller';
import { ScheduleOverviewController } from './schedule-overview.controller';
import { ScheduleManagementController } from './schedule-management.controller';
import { ScheduleManagementService } from './schedule-management.service';

@Module({
  imports: [AuthModule],
  controllers: [
    MeController,
    MakeupArtistPublicController,
    MakeupArtistTaskController,
    ControlRoomController,
    AdminController,
    ScheduleManagementController,
    ScheduleOverviewController
  ],
  providers: [ScheduleManagementService]
})
export class WorkspaceModule {}
