import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import {
  CurrentUser,
  Permissions,
  Public,
  Roles
} from '../common/auth.decorators';
import { DatabaseService } from '../database/database.service';
import { FeishuClient } from './feishu.client';
import {
  ResolveConflictDto,
  SaveFieldMappingDto,
  SaveTableMappingDto
} from './feishu.dto';
import { FeishuMappingService } from './feishu-mapping.service';
import { FeishuSyncService } from './feishu-sync.service';

@Controller('admin/feishu')
@Roles('ADMIN', 'DEVELOPER')
@Permissions('feishu.manage')
export class FeishuController {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly client: FeishuClient,
    private readonly mappings: FeishuMappingService,
    private readonly sync: FeishuSyncService
  ) {}

  @Get('status')
  status() {
    return this.mappings.status();
  }

  @Post('test-connection')
  async testConnection() {
    const tables = await this.client.listTables(
      this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN')
    );
    return { ok: true, tableCount: tables.length };
  }

  @Get('tables')
  tables() {
    return this.client.listTables(
      this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN')
    );
  }

  @Get('tables/:tableId/fields')
  fields(@Param('tableId') tableId: string) {
    return this.client.listFields(
      this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN'),
      tableId
    );
  }

  @Get('tables/:tableId/views')
  views(@Param('tableId') tableId: string) {
    return this.client.listViews(
      this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN'),
      tableId
    );
  }

  @Get('table-mappings')
  tableMappings() {
    return this.mappings.listTableMappings();
  }

  @Post('table-mappings')
  saveTableMapping(@Body() dto: SaveTableMappingDto) {
    return this.mappings.saveTableMapping(dto);
  }

  @Get('field-mappings')
  fieldMappings(@Query('tableMappingId') tableMappingId?: string) {
    return this.mappings.listFieldMappings(tableMappingId);
  }

  @Post('field-mappings')
  saveFieldMapping(@Body() dto: SaveFieldMappingDto) {
    return this.mappings.saveFieldMapping(dto);
  }

  @Post('appointment-mapping/auto-configure')
  autoConfigureAppointmentMapping() {
    return this.mappings.autoConfigureAppointmentMapping();
  }

  @Post('sync')
  syncAll() {
    return this.sync.runAll('MANUAL');
  }

  @Post('sync/:tableId')
  syncTable(@Param('tableId') tableId: string) {
    return this.sync.runTable(tableId, 'MANUAL');
  }

  @Get('appointment-writeback/status')
  appointmentWritebackStatus() {
    return this.sync.appointmentWritebackStatus();
  }

  @Post('appointment-writeback/drain')
  drainAppointmentWriteback() {
    return this.sync.drainFeishuWrites();
  }

  @Get('sync-logs')
  async syncLogs() {
    return (
      await this.db.query('SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT 200')
    ).rows;
  }

  @Get('conflicts')
  async conflicts() {
    return (
      await this.db.query(
        'SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT 200'
      )
    ).rows;
  }

  @Patch('conflicts/:id')
  async resolveConflict(
    @Param('id') id: string,
    @Body() dto: ResolveConflictDto,
    @CurrentUser() user: CurrentUserType
  ) {
    const result = await this.db.query(
      `
        UPDATE sync_conflicts
        SET status = 'RESOLVED', resolution = $2, resolved_by = $3,
            resolved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'OPEN'
        RETURNING *
      `,
      [id, dto.resolution, user.personId]
    );
    return result.rows[0] ?? null;
  }

}

@Controller('webhooks')
export class FeishuWebhookController {
  constructor(private readonly sync: FeishuSyncService) {}

  @Public()
  @Post('feishu')
  webhook(@Body() payload: Record<string, unknown>) {
    return this.sync.receiveWebhook(payload);
  }
}
