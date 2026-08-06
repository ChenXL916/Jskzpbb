import {
  ArrayNotEmpty,
  IsDateString,
  IsNumber,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min
} from 'class-validator';

export class GenerateMonthlyScheduleDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  roomIds!: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  coverageStartHour = 0;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  coverageEndHour = 24;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  blockHours = 4;

  @IsOptional()
  @IsIn(['PRESERVE_EXISTING', 'REPLACE_AUTO_PLAN'])
  existingSchedulePolicy?: 'PRESERVE_EXISTING' | 'REPLACE_AUTO_PLAN';

  /** @deprecated 仅兼容旧调用方；新接口使用 existingSchedulePolicy。 */
  @IsOptional()
  @IsIn(['PRESERVE_EXISTING', 'REPLACE_AUTO_PLAN'])
  generationStrategy?: 'PRESERVE_EXISTING' | 'REPLACE_AUTO_PLAN';

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsIn(['BUSINESS', 'BALANCED', 'CALIBRATION'])
  strategy?: 'BUSINESS' | 'BALANCED' | 'CALIBRATION';
}

export class UpdateScheduleAssignmentDto {
  @IsUUID()
  anchorId!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class MoveResizeScheduleAssignmentDto {
  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @IsUUID()
  roomId?: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BatchUpdateScheduleAssignmentsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  assignmentIds!: string[];

  @IsUUID()
  anchorId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AutoRepairSchedulePlanDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  assignmentIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateScheduleAssignmentLockDto {
  @IsBoolean()
  locked!: boolean;

  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SwapScheduleAssignmentsDto {
  @IsUUID()
  firstAssignmentId!: string;

  @IsUUID()
  secondAssignmentId!: string;

  @IsInt()
  @Min(1)
  firstVersion!: number;

  @IsInt()
  @Min(1)
  secondVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CloneSchedulePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}

export class CopySchedulePlanToMonthDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  targetMonth!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}

export class CompareSchedulePlansQueryDto {
  @IsUUID()
  leftId!: string;

  @IsUUID()
  rightId!: string;
}

export class PublishSchedulePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  softRiskReason?: string;
}

export class UpdateAnchorSchedulingProfileDto {
  @IsOptional()
  @IsBoolean()
  eligibleForAutoSchedule?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  targetMonthlyMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minMonthlyMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxMonthlyMinutes?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  preferredTimeBandCodes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  avoidedTimeBandCodes?: string[];

  @IsOptional()
  @IsDateString()
  employmentStartedOn?: string | null;

  @IsOptional()
  @IsDateString()
  employmentEndedOn?: string | null;
}

export class UpdateAnchorRoomEligibilityDto {
  @IsBoolean()
  eligible!: boolean;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateSchedulingStrategyDto {
  @IsInt()
  @Min(0)
  @Max(100)
  businessPriority!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  abilityWeight!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  fullTimePriority!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  partTimeFairness!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  developmentRatio!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  goldenTimeProtection!: number;
}

export class CreateAnchorAvailabilityExceptionDto {
  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsIn(['AVAILABLE', 'UNAVAILABLE', 'LEAVE', 'PREFERRED', 'AVOID'])
  availabilityType!: 'AVAILABLE' | 'UNAVAILABLE' | 'LEAVE' | 'PREFERRED' | 'AVOID';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateAnchorAvailabilityRuleDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  endMinute!: number;

  @IsIn(['AVAILABLE', 'UNAVAILABLE', 'PREFERRED', 'AVOID'])
  availabilityType!: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED' | 'AVOID';

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}

export class UpsertAnchorAbilityDto {
  @IsUUID()
  roomId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsNumber()
  @Min(0)
  sampleHours!: number;

  @IsNumber()
  @Min(0.001)
  capabilityScore!: number;

  @IsIn(['A', 'B', 'C'])
  confidenceGrade!: 'A' | 'B' | 'C';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceDocument?: string;
}

export class SchedulePlanMonthQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;
}

export class UpdateMonthlyScheduleAutomationDto {
  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(1)
  @Max(28)
  dayOfMonth!: number;

  @IsInt()
  @Min(0)
  @Max(23)
  hour!: number;

  @IsInt()
  @Min(0)
  @Max(59)
  minute!: number;

  @IsInt()
  @Min(1)
  @Max(3)
  monthsAhead!: number;
}
