import {
  ConflictException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Body
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import { CurrentUser, Permissions, Roles } from '../common/auth.decorators';
import { DatabaseService } from '../database/database.service';
import {
  AssignFieldControlDto,
  SaveLiveSessionDto,
  SaveStaffShiftDto
} from './schedule-management.dto';
import { ScheduleManagementService } from './schedule-management.service';

@Controller('schedules/manage')
@Roles('LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
@Permissions('schedule.manage')
export class ScheduleManagementController {
  constructor(
    private readonly service: ScheduleManagementService,
    private readonly db: DatabaseService
  ) {}

  @Get('options')
  options() {
    return this.service.options();
  }

  @Post('live-sessions')
  async createLiveSession(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: SaveLiveSessionDto
  ) {
    await this.assertLocalEditingAllowed();
    return this.service.createLiveSession(user, dto);
  }

  @Patch('live-sessions/:id')
  async updateLiveSession(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SaveLiveSessionDto
  ) {
    await this.assertLocalEditingAllowed();
    return this.service.updateLiveSession(user, id, dto);
  }

  @Post('live-sessions/:id/cancel')
  async cancelLiveSession(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    await this.assertLocalEditingAllowed();
    return this.service.cancelLiveSession(user, id);
  }

  @Patch('live-sessions/:id/field-control')
  assignFieldControl(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignFieldControlDto
  ) {
    return this.service.assignFieldControl(user, id, dto.fieldControlId);
  }

  @Post('staff-shifts')
  async createStaffShift(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: SaveStaffShiftDto
  ) {
    await this.assertLocalEditingAllowed();
    return this.service.createStaffShift(user, dto);
  }

  @Patch('staff-shifts/:id')
  async updateStaffShift(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SaveStaffShiftDto
  ) {
    await this.assertLocalEditingAllowed();
    return this.service.updateStaffShift(user, id, dto);
  }

  @Post('staff-shifts/:id/cancel')
  async cancelStaffShift(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    await this.assertLocalEditingAllowed();
    return this.service.cancelStaffShift(user, id);
  }

  private async assertLocalEditingAllowed(): Promise<void> {
    const result = await this.db.query<{ value: string }>(
      `SELECT value #>> '{}' AS value FROM system_settings WHERE key='schedule.data_authority'`
    );
    if (result.rows[0]?.value === 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS') {
      throw new ConflictException(
        '正式排班以飞书表格为准，请在飞书修改后回到人员排班执行同步'
      );
    }
  }
}
