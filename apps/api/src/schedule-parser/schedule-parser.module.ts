import { Module } from '@nestjs/common';
import { ShiftParserService } from './shift-parser.service';
import { LiveCellParserService } from './live-cell-parser.service';
import { LiveSessionMergeService } from './live-session-merge.service';

@Module({
  providers: [ShiftParserService, LiveCellParserService, LiveSessionMergeService],
  exports: [ShiftParserService, LiveCellParserService, LiveSessionMergeService]
})
export class ScheduleParserModule {}
