import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { FeishuClient } from './feishu.client';
import { SaveFieldMappingDto, SaveTableMappingDto } from './feishu.dto';

@Injectable()
export class FeishuMappingService {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly feishu: FeishuClient
  ) {}

  async status(): Promise<Record<string, unknown>> {
    const appToken = this.config.get<string>('FEISHU_BASE_APP_TOKEN') ?? '';
    const result = await this.db.query<{
      status: string;
      last_success_at: Date | null;
      last_failure_at: Date | null;
      last_error: string | null;
    }>('SELECT status, last_success_at, last_failure_at, last_error FROM feishu_connections LIMIT 1');
    const authority = await this.db.query<{ value: string }>(
      `SELECT value #>> '{}' AS value FROM system_settings WHERE key='schedule.data_authority'`
    );
    const mappings = await this.db.query<{
      enabled_count: number;
      last_synced_at: Date | null;
    }>(
      `
        SELECT count(*) FILTER (WHERE enabled)::int AS enabled_count,
               max(last_synced_at) FILTER (WHERE enabled) AS last_synced_at
        FROM feishu_table_mappings
        WHERE business_type IN (
          'STAFF_MONTHLY_SCHEDULE',
          'LIVE_ROOM_MONTHLY_SCHEDULE'
        )
      `
    );
    const dataAuthority =
      authority.rows[0]?.value ?? 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS';
    return {
      configured: this.feishu.isConfigured(),
      syncEnabled: this.config.get<boolean>('FEISHU_SYNC_ENABLED') ?? false,
      tableSyncEnabled: (mappings.rows[0]?.enabled_count ?? 0) > 0,
      enabledScheduleTableCount: mappings.rows[0]?.enabled_count ?? 0,
      lastScheduleSyncAt: mappings.rows[0]?.last_synced_at ?? null,
      dataAuthority,
      tableSyncMessage:
        '正式人员排班和主播直播时段从飞书同步；本地程序负责预约、冲突、状态、通知和审计。',
      appTokenMasked: appToken
        ? `${appToken.slice(0, 4)}…${appToken.slice(-4)}`
        : null,
      connection: result.rows[0] ?? null
    };
  }

  async connectionId(): Promise<string> {
    const appToken = this.config.get<string>('FEISHU_BASE_APP_TOKEN') ?? '';
    if (!appToken) throw new NotFoundException('FEISHU_BASE_APP_TOKEN 未配置');
    const result = await this.db.query<{ id: string }>(
      `
        INSERT INTO feishu_connections(id, name, app_token, status)
        VALUES ($1, '吉拾开张排班 Base', $2, 'CONFIGURED')
        ON CONFLICT (app_token) DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [randomUUID(), appToken]
    );
    return result.rows[0]!.id;
  }

  listTableMappings() {
    return this.db
      .query(
        `
          SELECT tm.*,
                 COALESCE(count(fm.id), 0)::int AS field_mapping_count
          FROM feishu_table_mappings tm
          LEFT JOIN feishu_field_mappings fm ON fm.table_mapping_id = tm.id
          GROUP BY tm.id
          ORDER BY tm.created_at
        `
      )
      .then((result) => result.rows);
  }

  async saveTableMapping(dto: SaveTableMappingDto) {
    const connectionId = await this.connectionId();
    const id = dto.id ?? randomUUID();
    const result = await this.db.query(
      `
        INSERT INTO feishu_table_mappings(
          id, connection_id, table_id, table_name, view_id,
          business_type, sync_direction, enabled
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (connection_id, table_id) DO UPDATE
        SET table_name=EXCLUDED.table_name, view_id=EXCLUDED.view_id,
            business_type=EXCLUDED.business_type,
            sync_direction=EXCLUDED.sync_direction,
            enabled=EXCLUDED.enabled, updated_at=now()
        RETURNING *
      `,
      [
        id,
        connectionId,
        dto.tableId,
        dto.tableName,
        dto.viewId ?? null,
        dto.businessType,
        dto.syncDirection,
        dto.enabled
      ]
    );
    return result.rows[0];
  }

  listFieldMappings(tableMappingId?: string) {
    const where = tableMappingId ? 'WHERE fm.table_mapping_id = $1' : '';
    return this.db
      .query(
        `
          SELECT fm.*, tm.table_id, tm.table_name, tm.business_type
          FROM feishu_field_mappings fm
          JOIN feishu_table_mappings tm ON tm.id = fm.table_mapping_id
          ${where}
          ORDER BY tm.table_name, fm.local_field_name
        `,
        tableMappingId ? [tableMappingId] : []
      )
      .then((result) => result.rows);
  }

  async saveFieldMapping(dto: SaveFieldMappingDto) {
    const table = await this.db.query<{ table_id: string }>(
      'SELECT table_id FROM feishu_table_mappings WHERE id=$1',
      [dto.tableMappingId]
    );
    if (!table.rows[0]) throw new NotFoundException('飞书表格映射不存在');
    const appToken = this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN');
    const fields = await this.feishu.listFields(appToken, table.rows[0].table_id);
    const actual = fields.find((field) => field.field_id === dto.feishuFieldId);
    if (!actual) throw new NotFoundException('飞书字段 ID 不存在或应用无权读取');
    const result = await this.db.query(
      `
        INSERT INTO feishu_field_mappings(
          id, table_mapping_id, feishu_field_id, feishu_field_name,
          feishu_field_type, local_field_name, transform_rule, required, enabled
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (table_mapping_id, feishu_field_id) DO UPDATE
        SET feishu_field_name=EXCLUDED.feishu_field_name,
            feishu_field_type=EXCLUDED.feishu_field_type,
            local_field_name=EXCLUDED.local_field_name,
            transform_rule=EXCLUDED.transform_rule,
            required=EXCLUDED.required,
            enabled=EXCLUDED.enabled,
            updated_at=now()
        RETURNING *
      `,
      [
        dto.id ?? randomUUID(),
        dto.tableMappingId,
        actual.field_id,
        actual.field_name,
        actual.type,
        dto.localFieldName,
        JSON.stringify(dto.transformRule ?? {}),
        dto.required,
        dto.enabled
      ]
    );
    return result.rows[0];
  }

  async autoConfigureAppointmentMapping() {
    const appToken = this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN');
    const existing = await this.db.query<{
      id: string;
      table_id: string;
      table_name: string;
    }>(
      `
        SELECT id, table_id, table_name
        FROM feishu_table_mappings
        WHERE business_type='MAKEUP_APPOINTMENTS'
        ORDER BY updated_at DESC
        LIMIT 1
      `
    );
    let table = existing.rows[0];
    if (!table) {
      const configuredTableId =
        this.config.get<string>('FEISHU_MAKEUP_APPOINTMENT_TABLE_ID') ?? '';
      const tables = await this.feishu.listTables(appToken);
      const remote = configuredTableId
        ? tables.find((item) => item.table_id === configuredTableId)
        : tables.find((item) => /妆造|化妆.*预约|预约/.test(item.name));
      if (!remote) {
        throw new NotFoundException(
          '未找到化妆师预约表，请先配置 FEISHU_MAKEUP_APPOINTMENT_TABLE_ID'
        );
      }
      const viewId =
        this.config.get<string>('FEISHU_MAKEUP_APPOINTMENT_VIEW_ID') ?? '';
      const saved = await this.saveTableMapping({
        tableId: remote.table_id,
        tableName: remote.name,
        ...(viewId ? { viewId } : {}),
        businessType: 'MAKEUP_APPOINTMENTS',
        syncDirection: 'LOCAL_TO_FEISHU',
        enabled: false
      });
      if (!saved) throw new NotFoundException('预约表映射保存失败');
      table = {
        id: String(saved.id),
        table_id: String(saved.table_id),
        table_name: String(saved.table_name)
      };
    }

    const remoteFields = await this.feishu.listFields(appToken, table.table_id);
    const specifications = [
      {
        local: 'createdAt',
        ids: ['fldmjQx3cm'],
        names: ['需求提出时间', '创建时间'],
        required: false
      },
      {
        local: 'requester',
        ids: ['fldxXhMD4F'],
        names: ['需求人', '预约人'],
        required: false
      },
      {
        local: 'requirementDescription',
        ids: ['fldS5Y1oQF'],
        names: ['需求描述', '妆造需求'],
        required: true
      },
      {
        local: 'plannedStartAt',
        ids: ['fld4aiJgmD'],
        names: ['化妆开始时间', '计划开始时间'],
        required: true
      },
      {
        local: 'plannedEndAt',
        ids: ['fldmbMKEfX'],
        names: ['化妆结束时间', '计划结束时间'],
        required: true
      },
      {
        local: 'makeupArtist',
        ids: ['fldCS2uArv'],
        names: ['需求处理人员', '化妆师'],
        required: false
      },
      {
        local: 'completed',
        ids: ['fldtRuTC3k'],
        names: ['是否完成'],
        required: false
      },
      {
        local: 'completionAttachments',
        ids: ['fldQRi3m74'],
        names: ['交付附件', '完成附件'],
        required: false
      },
      {
        local: 'artistShiftText',
        ids: ['fldLCqGH0s'],
        names: ['化妆师上班时间'],
        required: false
      },
      {
        local: 'exceptionNote',
        ids: ['fldgxR2yPg'],
        names: ['特殊情况备注', '异常备注'],
        required: false
      }
    ] as const;
    const matched = specifications
      .map((specification) => ({
        specification,
        field: remoteFields.find(
          (candidate) =>
            (specification.ids as readonly string[]).includes(candidate.field_id) ||
            (specification.names as readonly string[]).includes(
              candidate.field_name
            )
        )
      }))
      .filter(
        (item): item is (typeof item) & { field: NonNullable<typeof item.field> } =>
          Boolean(item.field)
      );
    const missingRequired = specifications
      .filter(
        (specification) =>
          specification.required &&
          !matched.some(
            (item) => item.specification.local === specification.local
          )
      )
      .map((item) => item.local);

    await this.db.transaction(async (client) => {
      for (const item of matched) {
        await client.query(
          `
            INSERT INTO feishu_field_mappings(
              id, table_mapping_id, feishu_field_id, feishu_field_name,
              feishu_field_type, local_field_name, transform_rule,
              required, enabled
            )
            VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,true)
            ON CONFLICT (table_mapping_id, feishu_field_id) DO UPDATE
            SET feishu_field_name=EXCLUDED.feishu_field_name,
                feishu_field_type=EXCLUDED.feishu_field_type,
                local_field_name=EXCLUDED.local_field_name,
                required=EXCLUDED.required, enabled=true, updated_at=now()
          `,
          [
            randomUUID(),
            table.id,
            item.field.field_id,
            item.field.field_name,
            item.field.type,
            item.specification.local,
            item.specification.required
          ]
        );
      }
      await client.query(
        `
          UPDATE feishu_table_mappings
          SET sync_direction='LOCAL_TO_FEISHU', enabled=$2,
              last_error=$3, updated_at=now()
          WHERE id=$1
        `,
        [
          table.id,
          missingRequired.length === 0,
          missingRequired.length
            ? `缺少必填字段映射：${missingRequired.join(', ')}`
            : null
        ]
      );
    });
    return {
      tableId: table.table_id,
      tableName: table.table_name,
      direction: 'LOCAL_TO_FEISHU',
      enabled: missingRequired.length === 0,
      mappedFields: matched.map((item) => ({
        fieldId: item.field.field_id,
        fieldName: item.field.field_name,
        localFieldName: item.specification.local
      })),
      missingRequired
    };
  }
}
