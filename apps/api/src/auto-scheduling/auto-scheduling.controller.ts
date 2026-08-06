import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import { CurrentUser, Permissions } from '../common/auth.decorators';
import {
  AutoRepairSchedulePlanDto,
  BatchUpdateScheduleAssignmentsDto,
  CloneSchedulePlanDto,
  CompareSchedulePlansQueryDto,
  CopySchedulePlanToMonthDto,
  GenerateMonthlyScheduleDto,
  MoveResizeScheduleAssignmentDto,
  PublishSchedulePlanDto,
  SchedulePlanMonthQueryDto,
  SwapScheduleAssignmentsDto,
  UpdateMonthlyScheduleAutomationDto,
  UpdateScheduleAssignmentDto,
  UpdateScheduleAssignmentLockDto
} from './auto-scheduling.dto';
import { AutoSchedulingService } from './auto-scheduling.service';

@Controller('schedule-plans')
@Permissions('schedule.auto_generate')
export class AutoSchedulingController {
  constructor(private readonly service: AutoSchedulingService) {}

  @Get('options')
  options() {
    return this.service.options();
  }

  @Get()
  list(@Query() query: SchedulePlanMonthQueryDto) {
    return this.service.list(query.month);
  }

  @Post('precheck')
  @Permissions('schedule.plan.generate')
  precheck(@Body() dto: GenerateMonthlyScheduleDto) {
    return this.service.precheck(dto);
  }

  @Get('compare')
  compare(@Query() query: CompareSchedulePlansQueryDto) {
    return this.service.compare(query.leftId, query.rightId);
  }

  @Patch('automation')
  updateAutomation(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: UpdateMonthlyScheduleAutomationDto
  ) {
    return this.service.updateAutomation(user, dto);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.get(id);
  }

  @Post('generate')
  @Permissions('schedule.plan.generate')
  generate(
    @CurrentUser() user: CurrentUserType,
    @Body() dto: GenerateMonthlyScheduleDto
  ) {
    return this.service.generate(user, dto);
  }

  @Patch(':planId/assignments/:assignmentId')
  @Permissions('schedule.plan.edit')
  updateAssignment(
    @CurrentUser() user: CurrentUserType,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: UpdateScheduleAssignmentDto
  ) {
    return this.service.updateAssignment(user, planId, assignmentId, dto);
  }

  @Patch(':planId/assignments/:assignmentId/time')
  @Permissions('schedule.plan.edit')
  moveResizeAssignment(
    @CurrentUser() user: CurrentUserType,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: MoveResizeScheduleAssignmentDto
  ) {
    return this.service.moveResizeAssignment(user, planId, assignmentId, dto);
  }

  @Patch(':id/assignments-batch')
  @Permissions('schedule.plan.edit')
  batchUpdateAssignments(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: BatchUpdateScheduleAssignmentsDto
  ) {
    return this.service.batchUpdateAssignments(user, id, dto);
  }

  @Patch(':planId/assignments/:assignmentId/lock')
  @Permissions('schedule.plan.edit')
  updateAssignmentLock(
    @CurrentUser() user: CurrentUserType,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: UpdateScheduleAssignmentLockDto
  ) {
    return this.service.updateAssignmentLock(user, planId, assignmentId, dto);
  }

  @Post(':id/swap')
  @Permissions('schedule.plan.edit')
  swap(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SwapScheduleAssignmentsDto
  ) {
    return this.service.swapAssignments(user, id, dto);
  }

  @Post(':id/clone')
  @Permissions('schedule.plan.generate')
  clone(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CloneSchedulePlanDto
  ) {
    return this.service.clone(user, id, dto);
  }

  @Post(':id/copy-to-month')
  @Permissions('schedule.plan.generate')
  copyToMonth(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CopySchedulePlanToMonthDto
  ) {
    return this.service.copyToMonth(user, id, dto);
  }

  @Post(':id/auto-repair')
  @Permissions('schedule.plan.edit')
  autoRepair(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AutoRepairSchedulePlanDto
  ) {
    return this.service.autoRepair(user, id, dto);
  }

  @Post(':id/undo')
  @Permissions('schedule.plan.history')
  undo(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.undo(user, id);
  }

  @Post(':id/redo')
  @Permissions('schedule.plan.history')
  redo(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.redo(user, id);
  }

  @Post(':id/rollback')
  @Permissions('schedule.plan.publish')
  rollback(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CloneSchedulePlanDto
  ) {
    return this.service.rollback(user, id, dto);
  }

  @Post(':id/validate')
  @Permissions('schedule.plan.review')
  validate(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.validate(user, id);
  }

  @Post(':id/publish')
  @Permissions('schedule.plan.publish')
  publish(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PublishSchedulePlanDto
  ) {
    return this.service.publish(user, id, dto);
  }
}
