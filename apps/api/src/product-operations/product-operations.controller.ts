import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import {
  CurrentUser,
  Permissions,
  Roles
} from '../common/auth.decorators';
import {
  PaginationQueryDto,
  ResolveRiskDto,
  TemporaryStatusDto,
  UpdateBookingRulesDto
} from './product-operations.dto';
import { ProductOperationsService } from './product-operations.service';

@Controller('admin')
@Roles('ADMIN', 'DEVELOPER')
export class ProductAdminController {
  constructor(private readonly operations: ProductOperationsService) {}

  @Get('roles')
  @Permissions('people.manage')
  roles() {
    return this.operations.roles();
  }

  @Get('permissions')
  @Permissions('people.manage')
  permissions() {
    return this.operations.permissions();
  }

  @Get('booking-rules')
  @Permissions('settings.manage')
  bookingRules() {
    return this.operations.bookingRules();
  }

  @Patch('booking-rules')
  @Permissions('settings.manage')
  updateBookingRules(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: UpdateBookingRulesDto
  ) {
    return this.operations.updateBookingRules(user, dto.settings);
  }

  @Get('sync-jobs')
  @Permissions('logs.view')
  syncJobs(@Query() query: PaginationQueryDto) {
    return this.operations.syncJobs(query);
  }

  @Get('operation-logs')
  @Permissions('logs.view')
  operationLogs(@Query() query: PaginationQueryDto) {
    return this.operations.operationLogs(query);
  }
}

@Controller('management')
@Roles('LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
export class ManagementController {
  constructor(private readonly operations: ProductOperationsService) {}

  @Get('dashboard')
  dashboard() {
    return this.operations.managementDashboard();
  }

  @Get('workload')
  workload() {
    return this.operations.workload();
  }

  @Get('risks')
  risks() {
    return this.operations.openRisks();
  }
}

@Controller('makeup-artist')
@Roles('MAKEUP_ARTIST')
export class MakeupArtistDashboardController {
  constructor(private readonly operations: ProductOperationsService) {}

  @Get('dashboard')
  dashboard(@CurrentUser() user: CurrentUserType) {
    return this.operations.makeupArtistDashboard(user);
  }

  @Patch('temporary-status')
  temporaryStatus(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: TemporaryStatusDto
  ) {
    return this.operations.setTemporaryStatus(user, dto);
  }
}

@Controller('notifications')
export class NotificationController {
  constructor(private readonly operations: ProductOperationsService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserType,
    @Query() query: PaginationQueryDto
  ) {
    return this.operations.notifications(user, query);
  }

  @Patch('read-all')
  readAll(@CurrentUser() user: CurrentUserType) {
    return this.operations.markAllNotificationsRead(user);
  }

  @Patch(':id/read')
  read(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string
  ) {
    return this.operations.markNotificationRead(user, id);
  }
}

@Controller('risks')
@Roles('FIELD_CONTROL', 'LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
export class RiskCenterController {
  constructor(private readonly operations: ProductOperationsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    const elevated = user.roles.some((role) =>
      ['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER'].includes(role)
    );
    return this.operations.openRisks(elevated ? undefined : user.roomIds);
  }

  @Patch(':id/resolve')
  resolve(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: ResolveRiskDto
  ) {
    return this.operations.resolveRisk(user, id, dto.note);
  }
}
