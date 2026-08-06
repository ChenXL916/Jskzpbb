import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import { CurrentUser, Permissions, Roles } from '../common/auth.decorators';
import { ScheduleImportFile, ScheduleImportService } from './schedule-import.service';

@Controller('admin/scheduling/imports')
@Roles('LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER')
@Permissions('schedule.plan.import')
export class SchedulingImportController {
  constructor(private readonly service: ScheduleImportService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.get(id);
  }

  @Post(':type/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(
    @CurrentUser() user: CurrentUserType,
    @Param('type') type: string,
    @UploadedFile() file?: ScheduleImportFile
  ) {
    return this.service.upload(user, type, file);
  }

  @Post(':id/commit')
  commit(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.commit(user, id);
  }

  @Post(':id/rollback')
  rollback(
    @CurrentUser() user: CurrentUserType,
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.service.rollback(user, id);
  }
}
