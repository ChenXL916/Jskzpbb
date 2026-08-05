import { PersonRole } from '@jishi/contracts';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength
} from 'class-validator';

export class SaveLiveSessionDto {
  @IsUUID()
  roomId!: string;

  @IsUUID()
  anchorId!: string;

  @IsOptional()
  @IsUUID()
  fieldControlId?: string;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;

  @IsOptional()
  @IsIn(['LIVE', 'REHEARSAL', 'TRAINING'])
  scheduleType: 'LIVE' | 'REHEARSAL' | 'TRAINING' = 'LIVE';

  @IsBoolean()
  makeupRequired!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class AssignFieldControlDto {
  @IsOptional()
  @IsUUID()
  fieldControlId?: string;
}

export class SaveStaffShiftDto {
  @IsUUID()
  personId!: string;

  @IsIn(['ANCHOR', 'MAKEUP_ARTIST', 'FIELD_CONTROL'])
  role!: Extract<PersonRole, 'ANCHOR' | 'MAKEUP_ARTIST' | 'FIELD_CONTROL'>;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  scheduleDate!: string;

  @IsOptional()
  @IsUUID()
  shiftTemplateId?: string;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  rawShiftValue?: string;

  @IsBoolean()
  isRest!: boolean;

  @IsBoolean()
  isLeave!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
