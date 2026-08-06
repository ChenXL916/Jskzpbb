import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import {
  AnyPermissions,
  CurrentUser,
  Permissions,
  Roles
} from '../common/auth.decorators';
import {
  AppointmentExceptionDto,
  ManualTaskDto,
  QuickBookDto,
  RecommendationQueryDto,
  RequesterAvailabilityQueryDto,
  RequesterBookDto,
  RescheduleAppointmentDto
} from './appointment.dto';
import { AppointmentService } from './appointment.service';

@Controller('appointments')
export class AppointmentController {
  constructor(private readonly appointments: AppointmentService) {}

  @Get('recommendations')
  @Roles('ANCHOR', 'FIELD_CONTROL', 'LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
  @AnyPermissions('appointment.create', 'appointment.create_for_anchor')
  recommendations(
    @CurrentUser() user: CurrentUserType,
    @Query() query: RecommendationQueryDto
  ) {
    return this.appointments.recommendation(
      user,
      query.liveSessionId,
      query.serviceTypeCode
    );
  }

  @Post('quick-book')
  @Roles('ANCHOR', 'FIELD_CONTROL', 'LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
  @AnyPermissions('appointment.create', 'appointment.create_for_anchor')
  quickBook(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: QuickBookDto,
    @Headers('idempotency-key') idempotencyKey: string
  ) {
    return this.appointments.quickBook(user, dto, idempotencyKey);
  }

  @Get('requester-dashboard')
  @Roles('TALENT', 'DIRECTOR', 'ADMIN', 'DEVELOPER')
  @Permissions('makeup.availability.view')
  requesterDashboard(
    @CurrentUser() user: CurrentUserType,
    @Query() query: RequesterAvailabilityQueryDto
  ) {
    return this.appointments.requesterDashboard(
      user,
      query.date,
      query.serviceTypeCode
    );
  }

  @Post('requester-book')
  @Roles('TALENT', 'DIRECTOR')
  @Permissions('appointment.create')
  requesterBook(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: RequesterBookDto,
    @Headers('idempotency-key') idempotencyKey: string
  ) {
    return this.appointments.requesterBook(user, dto, idempotencyKey);
  }

  @Post('manual-task')
  @Roles('MAKEUP_ARTIST')
  manualTask(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: ManualTaskDto,
    @Headers('idempotency-key') idempotencyKey: string
  ) {
    return this.appointments.manualTask(user, dto, idempotencyKey);
  }

  @Patch(':id/start')
  @Roles('MAKEUP_ARTIST')
  @Permissions('appointment.start')
  start(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.appointments.start(user, id);
  }

  @Patch(':id/complete')
  @Roles('MAKEUP_ARTIST')
  @Permissions('appointment.complete')
  complete(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.appointments.complete(user, id);
  }

  @Patch(':id/exception')
  @Roles('MAKEUP_ARTIST')
  @Permissions('appointment.start')
  exception(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: AppointmentExceptionDto
  ) {
    return this.appointments.exception(user, id, dto);
  }

  @Patch(':id/cancel')
  @Permissions('appointment.cancel')
  cancel(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.appointments.cancel(user, id);
  }

  @Patch(':id/reschedule')
  @Permissions('appointment.update')
  reschedule(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: RescheduleAppointmentDto
  ) {
    return this.appointments.reschedule(user, id, dto);
  }
}
