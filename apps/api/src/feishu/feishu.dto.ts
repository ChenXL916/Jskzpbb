import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength
} from 'class-validator';

export class SaveTableMappingDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MaxLength(128)
  tableId!: string;

  @IsString()
  @MaxLength(255)
  tableName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  viewId?: string;

  @IsIn([
    'STAFF_MONTHLY_SCHEDULE',
    'LIVE_ROOM_MONTHLY_SCHEDULE',
    'MAKEUP_APPOINTMENTS',
    'PEOPLE'
  ])
  businessType!: string;

  @IsIn(['FEISHU_TO_LOCAL', 'LOCAL_TO_FEISHU', 'BIDIRECTIONAL'])
  syncDirection!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class SaveFieldMappingDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsUUID()
  tableMappingId!: string;

  @IsString()
  @MaxLength(128)
  feishuFieldId!: string;

  @IsString()
  @MaxLength(255)
  feishuFieldName!: string;

  @IsInt()
  feishuFieldType!: number;

  @IsString()
  @MaxLength(100)
  localFieldName!: string;

  @IsOptional()
  @IsObject()
  transformRule?: Record<string, unknown>;

  @IsBoolean()
  required!: boolean;

  @IsBoolean()
  enabled!: boolean;
}

export class ResolveConflictDto {
  @IsIn(['KEEP_LOCAL', 'USE_FEISHU', 'IGNORE', 'RETRY'])
  resolution!: string;
}
