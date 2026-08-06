import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import {
  CurrentUser,
  Permissions,
  Roles
} from '../common/auth.decorators';
import {
  GroupNotificationQueryDto,
  UpdateScheduleNotificationRuleDto
} from './schedule-notification.dto';
import { ScheduleNotificationService } from './schedule-notification.service';

@Controller('admin/schedule-notifications')
@Roles('ADMIN', 'DEVELOPER')
@Permissions('notifications.manage')
export class ScheduleNotificationController {
  constructor(private readonly notifications: ScheduleNotificationService) {}

  @Get('rules')
  rules() {
    return this.notifications.rules();
  }

  @Patch('rules/:id')
  updateRule(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: UpdateScheduleNotificationRuleDto
  ) {
    return this.notifications.updateRule(user, id, dto);
  }

  @Post('rules/:id/test')
  test(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string
  ) {
    return this.notifications.enqueueTest(user, id);
  }

  @Get('outbox')
  outbox(@Query() query: GroupNotificationQueryDto) {
    return this.notifications.outbox(query);
  }

  @Post('outbox/:id/retry')
  retry(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string
  ) {
    return this.notifications.retry(user, id);
  }
}
