import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min
} from 'class-validator';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}

export class UpdateBookingRulesDto {
  @IsObject()
  settings!: Record<string, unknown>;
}

export class TemporaryStatusDto {
  @IsIn(['BREAK', 'LEAVE', 'UNAVAILABLE', 'TRAINING'])
  statusType!: 'BREAK' | 'LEAVE' | 'UNAVAILABLE' | 'TRAINING';

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ResolveRiskDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
