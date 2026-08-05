import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import { CurrentUser, Permissions, Roles } from '../common/auth.decorators';
import {
  CreateAnchorAvailabilityExceptionDto,
  CreateAnchorAvailabilityRuleDto,
  UpdateAnchorRoomEligibilityDto,
  UpdateAnchorSchedulingProfileDto,
  UpdateSchedulingStrategyDto,
  UpsertAnchorAbilityDto
} from './auto-scheduling.dto';
import { AutoSchedulingService } from './auto-scheduling.service';

@Controller('admin/scheduling')
@Roles('LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
export class SchedulingConfigurationController {
  constructor(private readonly service: AutoSchedulingService) {}

  @Get('configuration')
  @Permissions('schedule.rule.manage')
  configuration() {
    return this.service.configuration();
  }

  @Patch('strategy')
  @Permissions('schedule.rule.manage')
  updateStrategy(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: UpdateSchedulingStrategyDto
  ) {
    return this.service.updateSchedulingStrategy(user, dto);
  }

  @Patch('anchors/:anchorId/profile')
  @Permissions('schedule.rule.manage')
  updateAnchorProfile(
    @CurrentUser() user: CurrentUserType,
    @Param('anchorId', new ParseUUIDPipe()) anchorId: string,
    @Body() dto: UpdateAnchorSchedulingProfileDto
  ) {
    return this.service.updateAnchorProfile(user, anchorId, dto);
  }

  @Patch('anchors/:anchorId/rooms/:roomId')
  @Permissions('schedule.rule.manage')
  updateAnchorRoomEligibility(
    @CurrentUser() user: CurrentUserType,
    @Param('anchorId', new ParseUUIDPipe()) anchorId: string,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Body() dto: UpdateAnchorRoomEligibilityDto
  ) {
    return this.service.updateAnchorRoomEligibility(
      user,
      anchorId,
      roomId,
      dto
    );
  }

  @Post('anchors/:anchorId/availability-exceptions')
  @Permissions('schedule.rule.manage')
  createAvailabilityException(
    @CurrentUser() user: CurrentUserType,
    @Param('anchorId', new ParseUUIDPipe()) anchorId: string,
    @Body() dto: CreateAnchorAvailabilityExceptionDto
  ) {
    return this.service.createAvailabilityException(user, anchorId, dto);
  }

  @Delete('availability-exceptions/:id')
  @Permissions('schedule.rule.manage')
  deleteAvailabilityException(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.deleteAvailabilityException(user, id);
  }

  @Post('anchors/:anchorId/availability-rules')
  @Permissions('schedule.rule.manage')
  createAvailabilityRule(
    @CurrentUser() user: CurrentUserType,
    @Param('anchorId', new ParseUUIDPipe()) anchorId: string,
    @Body() dto: CreateAnchorAvailabilityRuleDto
  ) {
    return this.service.createAvailabilityRule(user, anchorId, dto);
  }

  @Delete('availability-rules/:id')
  @Permissions('schedule.rule.manage')
  deleteAvailabilityRule(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.deleteAvailabilityRule(user, id);
  }

  @Post('anchors/:anchorId/abilities')
  @Permissions('schedule.ability.manage')
  upsertAbility(
    @CurrentUser() user: CurrentUserType,
    @Param('anchorId', new ParseUUIDPipe()) anchorId: string,
    @Body() dto: UpsertAnchorAbilityDto
  ) {
    return this.service.upsertAbility(user, anchorId, dto);
  }
}
