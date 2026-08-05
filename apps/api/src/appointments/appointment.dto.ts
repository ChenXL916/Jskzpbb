import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength
} from 'class-validator';

export class RecommendationQueryDto {
  @IsUUID()
  liveSessionId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  serviceTypeCode?: string;
}

export class QuickBookDto extends RecommendationQueryDto {
  @IsOptional()
  @IsUUID()
  makeupArtistId?: string;
}

export class RescheduleAppointmentDto {
  @IsISO8601()
  plannedStartAt!: string;

  @IsOptional()
  @IsUUID()
  makeupArtistId?: string;
}

export class AppointmentExceptionDto {
  @IsString()
  @MaxLength(50)
  exceptionType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ManualTaskDto {
  @IsUUID()
  liveSessionId!: string;

  @IsISO8601()
  plannedStartAt!: string;

  @IsISO8601()
  plannedEndAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  serviceTypeCode?: string;
}

export class RequesterAvailabilityQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  serviceTypeCode?: string;
}

export class RequesterBookDto {
  @IsUUID()
  makeupArtistId!: string;

  @IsISO8601()
  plannedStartAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  serviceTypeCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
