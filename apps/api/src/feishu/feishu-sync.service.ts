import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { PersonRole } from '@jishi/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseError } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  LiveCellParserService,
  ParsedLiveCellEntry
} from '../schedule-parser/live-cell-parser.service';
import {
  LiveSessionMergeService,
  MergeableSlot
} from '../schedule-parser/live-session-merge.service';
import {
  ShiftParserService,
  ShiftTemplateInput
} from '../schedule-parser/shift-parser.service';
import { FeishuClient, FeishuRecord } from './feishu.client';

interface TableMappingRow {
  id: string;
  connection_id: string;
  table_id: string;
  table_name: string;
  view_id: string | null;
  business_type:
    | 'STAFF_MONTHLY_SCHEDULE'
    | 'LIVE_ROOM_MONTHLY_SCHEDULE'
    | 'MAKEUP_APPOINTMENTS'
    | 'PEOPLE';
  sync_direction: string;
}

interface FieldMappingRow {
  id: string;
  table_mapping_id: string;
  feishu_field_id: string;
  feishu_field_name: string;
  feishu_field_type: number;
  local_field_name: string;
  transform_rule: Record<string, unknown>;
  required: boolean;
}

interface SyncCounts {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface FeishuWriteOutboxRow {
  id: string;
  aggregate_id: string;
  retry_count: number;
}

interface AppointmentWriteRow extends Record<string, unknown> {
  id: string;
  appointment_no: string;
  status: string;
  makeup_date: string;
  planned_start_at: Date;
  planned_end_at: Date;
  actual_start_at: Date | null;
  actual_end_at: Date | null;
  location: string;
  exception_type: string | null;
  exception_note: string | null;
  original_requirement: string | null;
  created_at: Date;
  source_record_id: string | null;
  subject_name: string;
  subject_open_id: string | null;
  subject_type: 'ANCHOR' | 'TALENT' | 'DIRECTOR';
  artist_name: string;
  artist_open_id: string | null;
  requester_name: string;
  requester_open_id: string | null;
  room_name: string;
  service_type: string;
}

@Injectable()
export class FeishuSyncService {
  private readonly logger = new Logger(FeishuSyncService.name);
  private scheduledSyncRunning = false;
  private readonly scheduleBusinessTypes = [
    'STAFF_MONTHLY_SCHEDULE',
    'LIVE_ROOM_MONTHLY_SCHEDULE'
  ] as const;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly client: FeishuClient,
    private readonly shiftParser: ShiftParserService,
    private readonly liveCellParser: LiveCellParserService,
    private readonly sessionMerger: LiveSessionMergeService
  ) {}

  async runAll(jobType: 'MANUAL' | 'SCHEDULED' | 'WEBHOOK') {
    const mappings = await this.db.query<TableMappingRow>(
      `
        SELECT *
        FROM feishu_table_mappings
        WHERE enabled
          AND business_type=ANY($1::text[])
          AND sync_direction IN ('FEISHU_TO_LOCAL','BIDIRECTIONAL')
        ORDER BY CASE business_type
          WHEN 'STAFF_MONTHLY_SCHEDULE' THEN 1
          WHEN 'LIVE_ROOM_MONTHLY_SCHEDULE' THEN 2
          ELSE 3
        END, created_at
      `,
      [this.scheduleBusinessTypes]
    );
    const results: unknown[] = [];
    for (const mapping of mappings.rows) {
      results.push(await this.runMapping(mapping, jobType));
    }
    return results;
  }

  async runTable(
    tableId: string,
    jobType: 'MANUAL' | 'SCHEDULED' | 'WEBHOOK'
  ) {
    const mapping = await this.db.query<TableMappingRow>(
      `
        SELECT *
        FROM feishu_table_mappings
        WHERE table_id=$1 AND enabled
          AND business_type=ANY($2::text[])
          AND sync_direction IN ('FEISHU_TO_LOCAL','BIDIRECTIONAL')
      `,
      [tableId, this.scheduleBusinessTypes]
    );
    if (!mapping.rows[0]) {
      throw new NotFoundException('该飞书数据表不是已启用的正式排班表');
    }
    return this.runMapping(mapping.rows[0], jobType);
  }

  async receiveWebhook(payload: Record<string, unknown>) {
    if (typeof payload.challenge === 'string') {
      const expected = this.config.get<string>('FEISHU_WEBHOOK_VERIFICATION_TOKEN') ?? '';
      if (expected && payload.token !== expected) {
        throw new ForbiddenException('飞书回调验证令牌不匹配');
      }
      return { challenge: payload.challenge };
    }

    const header = (payload.header ?? {}) as Record<string, unknown>;
    const eventId = typeof header.event_id === 'string' ? header.event_id : '';
    const eventType =
      typeof header.event_type === 'string' ? header.event_type : '';
    if (!eventId || !eventType) throw new ForbiddenException('飞书事件缺少事件标识');
    const expected = this.config.get<string>('FEISHU_WEBHOOK_VERIFICATION_TOKEN') ?? '';
    if (expected && header.token !== expected && payload.token !== expected) {
      throw new ForbiddenException('飞书事件来源验证失败');
    }

    const inserted = await this.db.query(
      `
        INSERT INTO webhook_events(event_id, event_type, payload)
        VALUES ($1,$2,$3)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING id
      `,
      [eventId, eventType, JSON.stringify(payload)]
    );
    if (!inserted.rows[0]) return { ok: true, duplicate: true };

    if (this.config.get<boolean>('FEISHU_SYNC_ENABLED')) {
      setImmediate(() => {
        void this.runAll('WEBHOOK')
          .then(() =>
            this.db.query(
              `UPDATE webhook_events SET status='PROCESSED', processed_at=now() WHERE event_id=$1`,
              [eventId]
            )
          )
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`webhook ${eventId} sync failed: ${message}`);
            return this.db.query(
              `
                UPDATE webhook_events
                SET status='FAILED', retry_count=retry_count+1, error_message=$2
                WHERE event_id=$1
              `,
              [eventId, message]
            );
          });
      });
    }
    return { ok: true, duplicate: false };
  }

  @Interval(60_000)
  async scheduledSync(): Promise<void> {
    if (
      !this.config.get<boolean>('FEISHU_SYNC_ENABLED') ||
      !this.client.isConfigured() ||
      this.scheduledSyncRunning
    ) {
      return;
    }
    const minutes = this.config.get<number>('FEISHU_SYNC_INTERVAL_MINUTES') ?? 5;
    const latest = await this.db.query<{ last_run: Date | null }>(
      `SELECT max(created_at) AS last_run FROM sync_jobs WHERE job_type='SCHEDULED'`
    );
    if (
      latest.rows[0]?.last_run &&
      Date.now() - latest.rows[0].last_run.getTime() < minutes * 60_000
    ) {
      return;
    }
    this.scheduledSyncRunning = true;
    try {
      await this.runAll('SCHEDULED');
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : 'scheduled sync failed'
      );
    } finally {
      this.scheduledSyncRunning = false;
    }
  }

  @Interval(15_000)
  async drainFeishuWrites(): Promise<{ processed: number; enabled: boolean }> {
    const enabled =
      this.config.get<boolean>('FEISHU_APPOINTMENT_WRITEBACK_ENABLED') ?? false;
    if (!enabled) return { processed: 0, enabled: false };
    if (
      !this.config.get<boolean>('FEISHU_SYNC_ENABLED') ||
      !this.client.isConfigured()
    ) {
      return { processed: 0, enabled: true };
    }
    const rows = await this.claimFeishuWrites();
    for (const row of rows) {
      await this.processFeishuWrite(row);
    }
    return { processed: rows.length, enabled: true };
  }

  async appointmentWritebackStatus(): Promise<Record<string, unknown>> {
    const [mapping, outbox] = await Promise.all([
      this.db.query<{
        id: string;
        table_id: string;
        table_name: string;
        enabled: boolean;
        sync_direction: string;
        field_count: number;
      }>(
        `
          SELECT mapping.id, mapping.table_id, mapping.table_name,
                 mapping.enabled, mapping.sync_direction,
                 count(field.id) FILTER (WHERE field.enabled)::int AS field_count
          FROM feishu_table_mappings mapping
          LEFT JOIN feishu_field_mappings field
            ON field.table_mapping_id=mapping.id
          WHERE mapping.business_type='MAKEUP_APPOINTMENTS'
          GROUP BY mapping.id
          ORDER BY mapping.updated_at DESC
          LIMIT 1
        `
      ),
      this.db.query<{ status: string; count: number }>(
        `
          SELECT status, count(*)::int AS count
          FROM feishu_write_outbox
          GROUP BY status
          ORDER BY status
        `
      )
    ]);
    return {
      enabled:
        this.config.get<boolean>('FEISHU_APPOINTMENT_WRITEBACK_ENABLED') ??
        false,
      clientConfigured: this.client.isConfigured(),
      mapping: mapping.rows[0] ?? null,
      outbox: Object.fromEntries(
        outbox.rows.map((row) => [row.status, row.count])
      )
    };
  }

  private async runMapping(
    mapping: TableMappingRow,
    jobType: 'MANUAL' | 'SCHEDULED' | 'WEBHOOK'
  ) {
    const jobId = randomUUID();
    const counts: SyncCounts = {
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0
    };
    await this.db.query(
      `
        INSERT INTO sync_jobs(id, job_type, table_mapping_id, status, started_at)
        VALUES ($1,$2,$3,'RUNNING',now())
      `,
      [jobId, jobType, mapping.id]
    );

    try {
      const fields = await this.validateAndRefreshFields(mapping);
      const normalizationFingerprint =
        await this.normalizationFingerprint(mapping);
      let pageToken: string | undefined;
      do {
        const page = await this.client.searchRecords(
          this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN'),
          mapping.table_id,
          {
            ...(mapping.view_id ? { viewId: mapping.view_id } : {}),
            ...(pageToken ? { pageToken } : {}),
            pageSize: 500,
            automaticFields: true
          }
        );
        for (const record of page.items ?? []) {
          counts.fetched += 1;
          try {
            const outcome = await this.processRecord(
              mapping,
              fields,
              record,
              normalizationFingerprint
            );
            counts[outcome] += 1;
          } catch (error) {
            counts.failed += 1;
            await this.recordConflict(
              mapping,
              record.record_id,
              'RECORD_PARSE_OR_WRITE_FAILED',
              record.fields,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
        pageToken = page.has_more ? page.page_token : undefined;
        await this.db.query(
          'UPDATE sync_jobs SET cursor=$2, fetched_count=$3, updated_at=now() WHERE id=$1',
          [jobId, pageToken ?? null, counts.fetched]
        );
      } while (pageToken);

      if (mapping.business_type === 'LIVE_ROOM_MONTHLY_SCHEDULE') {
        await this.rebuildLiveSessions(mapping);
      }

      const status = counts.failed > 0 ? 'PARTIAL' : 'SUCCEEDED';
      await this.db.query(
        `
          UPDATE sync_jobs
          SET status=$2, fetched_count=$3, created_count=$4, updated_count=$5,
              skipped_count=$6, failed_count=$7, finished_at=now(), updated_at=now()
          WHERE id=$1
        `,
        [
          jobId,
          status,
          counts.fetched,
          counts.created,
          counts.updated,
          counts.skipped,
          counts.failed
        ]
      );
      await this.db.query(
        `
          UPDATE feishu_table_mappings
          SET last_synced_at=now(), last_success_at=now(), last_error=NULL
          WHERE id=$1
        `,
        [mapping.id]
      );
      await this.db.query(
        `
          UPDATE feishu_connections
          SET status='CONNECTED', last_success_at=now(), last_error=NULL
          WHERE id=$1
        `,
        [mapping.connection_id]
      );
      return { jobId, status, ...counts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `
          UPDATE sync_jobs
          SET status='FAILED', error_message=$2, failed_count=$3,
              finished_at=now(), updated_at=now()
          WHERE id=$1
        `,
        [jobId, message, counts.failed]
      );
      await this.db.query(
        `
          UPDATE feishu_connections
          SET status='ERROR', last_failure_at=now(), last_error=$2
          WHERE id=$1
        `,
        [mapping.connection_id, message]
      );
      await this.db.query(
        `
          UPDATE feishu_table_mappings
          SET last_failure_at=now(), last_error=$2
          WHERE id=$1
        `,
        [mapping.id, message]
      );
      throw error;
    }
  }

  private claimFeishuWrites(): Promise<FeishuWriteOutboxRow[]> {
    return this.db.transaction(async (client) => {
      const result = await client.query<FeishuWriteOutboxRow>(
        `
          SELECT id, aggregate_id, retry_count
          FROM feishu_write_outbox
          WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 20
        `
      );
      if (result.rows.length) {
        await client.query(
          `UPDATE feishu_write_outbox SET status='RUNNING' WHERE id=ANY($1::uuid[])`,
          [result.rows.map((row) => row.id)]
        );
      }
      return result.rows;
    });
  }

  private async processFeishuWrite(row: FeishuWriteOutboxRow): Promise<void> {
    try {
      const mapping = await this.db.query<TableMappingRow>(
        `
          SELECT * FROM feishu_table_mappings
          WHERE business_type='MAKEUP_APPOINTMENTS' AND enabled
            AND sync_direction IN ('LOCAL_TO_FEISHU','BIDIRECTIONAL')
          ORDER BY created_at LIMIT 1
        `
      );
      if (!mapping.rows[0]) {
        await this.deferFeishuWrite(row.id, '尚未配置可写的化妆师预约表映射', 300);
        return;
      }
      const fieldMappings = await this.db.query<FieldMappingRow>(
        `
          SELECT * FROM feishu_field_mappings
          WHERE table_mapping_id=$1 AND enabled
        `,
        [mapping.rows[0].id]
      );
      const appointment = await this.db.query<AppointmentWriteRow>(
        `
          SELECT a.*, anchor.display_name AS anchor_name,
                 subject.display_name AS subject_name,
                 subject.feishu_open_id AS subject_open_id,
                 artist.display_name AS artist_name,
                 artist.feishu_open_id AS artist_open_id,
                 requester.display_name AS requester_name,
                 requester.feishu_open_id AS requester_open_id,
                 COALESCE(r.name, a.location) AS room_name,
                 st.name AS service_type
          FROM makeup_appointments a
          LEFT JOIN people anchor ON anchor.id=a.anchor_id
          JOIN people subject ON subject.id=a.subject_person_id
          JOIN people artist ON artist.id=a.makeup_artist_id
          JOIN people requester ON requester.id=a.requester_id
          LEFT JOIN rooms r ON r.id=a.room_id
          JOIN makeup_service_types st ON st.id=a.service_type_id
          WHERE a.id=$1
        `,
        [row.aggregate_id]
      );
      if (!appointment.rows[0]) throw new Error('待写回预约不存在');
      const fields = this.toFeishuAppointmentFields(
        appointment.rows[0],
        fieldMappings.rows
      );
      const appToken = this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN');
      let recordId = appointment.rows[0].source_record_id;
      if (recordId) {
        await this.client.updateRecord(
          appToken,
          mapping.rows[0].table_id,
          recordId,
          fields
        );
      } else {
        const remote = await this.client.createRecord(
          appToken,
          mapping.rows[0].table_id,
          fields,
          row.id
        );
        recordId = remote.record_id;
      }
      await this.db.transaction(async (client) => {
        await client.query(
          `
            UPDATE makeup_appointments
            SET source_type='APPLICATION', source_table_id=$2,
                source_record_id=$3, last_synced_at=now()
            WHERE id=$1
          `,
          [row.aggregate_id, mapping.rows[0]!.table_id, recordId]
        );
        await client.query(
          `
            UPDATE feishu_write_outbox
            SET status='SUCCEEDED', processed_at=now(), last_error=NULL
            WHERE id=$1
          `,
          [row.id]
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `
          UPDATE feishu_write_outbox
          SET status=CASE WHEN retry_count >= 9 THEN 'DEAD' ELSE 'FAILED' END,
              retry_count=retry_count+1,
              next_attempt_at=now() + make_interval(secs => LEAST(3600, 30 * power(2, retry_count)::int)),
              last_error=$2
          WHERE id=$1
        `,
        [row.id, message]
      );
    }
  }

  private async deferFeishuWrite(
    id: string,
    message: string,
    seconds: number
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE feishu_write_outbox
        SET status='PENDING', next_attempt_at=now()+make_interval(secs => $2),
            last_error=$3
        WHERE id=$1
      `,
      [id, seconds, message]
    );
  }

  private toFeishuAppointmentFields(
    appointment: AppointmentWriteRow,
    mappings: FieldMappingRow[]
  ): Record<string, unknown> {
    const localValues: Record<string, unknown> = {
      externalOrderNo: appointment.appointment_no,
      appointmentStatus: appointment.status,
      createdAt: appointment.created_at.getTime(),
      makeupDate: new Date(`${appointment.makeup_date}T00:00:00+08:00`).getTime(),
      anchor: appointment.subject_open_id
        ? [{ id: appointment.subject_open_id }]
        : undefined,
      makeupSubject: appointment.subject_open_id
        ? [{ id: appointment.subject_open_id }]
        : undefined,
      makeupSubjectName: appointment.subject_name,
      subjectType:
        appointment.subject_type === 'TALENT'
          ? '达人'
          : appointment.subject_type === 'DIRECTOR'
            ? '编导'
            : '主播',
      makeupArtist: appointment.artist_open_id
        ? [{ id: appointment.artist_open_id }]
        : undefined,
      makeupArtistName: appointment.artist_name,
      requester: appointment.requester_open_id
        ? [{ id: appointment.requester_open_id }]
        : undefined,
      requesterName: appointment.requester_name,
      roomName: appointment.room_name,
      serviceType: appointment.service_type,
      plannedStartAt: appointment.planned_start_at.getTime(),
      plannedEndAt: appointment.planned_end_at.getTime(),
      actualStartAt: appointment.actual_start_at?.getTime() ?? null,
      actualEndAt: appointment.actual_end_at?.getTime() ?? null,
      location: appointment.location,
      exceptionType: appointment.exception_type,
      exceptionNote: appointment.exception_note,
      completed: appointment.status === 'COMPLETED',
      requirementDescription: [
        `预约单号：${appointment.appointment_no}`,
        `妆造对象：${appointment.subject_name}`,
        `化妆师：${appointment.artist_name}`,
        `预约人：${appointment.requester_name}`,
        `妆造类型：${appointment.service_type}`,
        `直播间/地点：${appointment.room_name || appointment.location}`,
        `计划时间：${appointment.planned_start_at.toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false
        })} - ${appointment.planned_end_at.toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false
        })}`,
        `状态：${appointment.status}`,
        appointment.original_requirement
          ? `原始需求：${appointment.original_requirement}`
          : '',
        appointment.exception_note ? `异常备注：${appointment.exception_note}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      artistShiftText: `${appointment.artist_name}｜以系统内飞书排班镜像校验为准`
    };
    const result: Record<string, unknown> = {};
    for (const mapping of mappings) {
      const raw = localValues[mapping.local_field_name];
      if (raw === undefined || raw === null || raw === '') continue;
      const optionMap = mapping.transform_rule.optionMap;
      const transformed =
        optionMap &&
        typeof optionMap === 'object' &&
        !Array.isArray(optionMap) &&
        typeof raw === 'string' &&
        typeof (optionMap as Record<string, unknown>)[raw] === 'string'
          ? (optionMap as Record<string, string>)[raw]
          : raw;
      result[mapping.feishu_field_name] = transformed;
    }
    return result;
  }

  private async validateAndRefreshFields(
    mapping: TableMappingRow
  ): Promise<FieldMappingRow[]> {
    const mapped = await this.db.query<FieldMappingRow>(
      'SELECT * FROM feishu_field_mappings WHERE table_mapping_id=$1 AND enabled',
      [mapping.id]
    );
    const remote = await this.client.listFields(
      this.config.getOrThrow<string>('FEISHU_BASE_APP_TOKEN'),
      mapping.table_id
    );
    for (const field of mapped.rows) {
      const actual = remote.find((item) => item.field_id === field.feishu_field_id);
      if (!actual) {
        if (field.required) {
          throw new ConflictException(
            `必填字段 ${field.local_field_name} 已从飞书删除`
          );
        }
        continue;
      }
      if (actual.type !== field.feishu_field_type) {
        throw new ConflictException(
          `字段 ${actual.field_name} 类型已从 ${field.feishu_field_type} 变为 ${actual.type}`
        );
      }
      if (actual.field_name !== field.feishu_field_name) {
        await this.db.query(
          'UPDATE feishu_field_mappings SET feishu_field_name=$2, updated_at=now() WHERE id=$1',
          [field.id, actual.field_name]
        );
        field.feishu_field_name = actual.field_name;
      }
    }
    return mapped.rows.filter((field) =>
      remote.some((item) => item.field_id === field.feishu_field_id)
    );
  }

  private async processRecord(
    mapping: TableMappingRow,
    fields: FieldMappingRow[],
    record: FeishuRecord,
    normalizationFingerprint: string
  ): Promise<'created' | 'updated' | 'skipped'> {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          fields: record.fields,
          normalizationFingerprint
        })
      )
      .digest('hex');
    const existing = await this.db.query<{ content_hash: string }>(
      `
        SELECT content_hash FROM external_record_mappings
        WHERE source_system='FEISHU' AND source_table_id=$1
          AND source_record_id=$2 AND local_resource_type=$3
      `,
      [mapping.table_id, record.record_id, mapping.business_type]
    );
    if (existing.rows[0]?.content_hash === hash) return 'skipped';

    if (mapping.business_type === 'STAFF_MONTHLY_SCHEDULE') {
      await this.processStaffMonthlyRecord(mapping, fields, record);
    } else if (mapping.business_type === 'LIVE_ROOM_MONTHLY_SCHEDULE') {
      await this.processLiveMonthlyRecord(mapping, fields, record);
    } else if (mapping.business_type === 'MAKEUP_APPOINTMENTS') {
      await this.processRemoteAppointment(mapping, fields, record);
    } else {
      await this.processPersonRecord(mapping, fields, record);
    }

    await this.db.query(
      `
        INSERT INTO external_record_mappings(
          source_table_id, source_record_id, local_resource_type,
          source_version, content_hash, raw_data
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (source_system, source_table_id, source_record_id, local_resource_type)
        DO UPDATE SET source_version=EXCLUDED.source_version,
          content_hash=EXCLUDED.content_hash, raw_data=EXCLUDED.raw_data,
          last_synced_at=now(), updated_at=now(), deleted_at=NULL
      `,
      [
        mapping.table_id,
        record.record_id,
        mapping.business_type,
        record.last_modified_time ?? null,
        hash,
        JSON.stringify(record)
      ]
    );
    await this.db.query(
      `
        UPDATE sync_conflicts
        SET status='RESOLVED', resolution='RETRY_SUCCEEDED',
            resolved_at=now(), updated_at=now()
        WHERE source_table_id=$1 AND source_record_id=$2
          AND status='OPEN'
      `,
      [mapping.table_id, record.record_id]
    );
    return existing.rows[0] ? 'updated' : 'created';
  }

  private async normalizationFingerprint(
    mapping: TableMappingRow
  ): Promise<string> {
    if (mapping.business_type !== 'STAFF_MONTHLY_SCHEDULE') {
      return `${mapping.business_type}:parser-v2`;
    }
    const revision = await this.db.query<{ revision: string }>(
      `
        SELECT greatest(
          COALESCE(max(template.updated_at), 'epoch'::timestamptz),
          COALESCE(max(alias.updated_at), 'epoch'::timestamptz)
        )::text AS revision
        FROM shift_templates template
        LEFT JOIN shift_template_aliases alias
          ON alias.shift_template_id=template.id
      `
    );
    return `STAFF_MONTHLY_SCHEDULE:parser-v5:${
      revision.rows[0]?.revision ?? 'epoch'
    }`;
  }

  private async processStaffMonthlyRecord(
    mapping: TableMappingRow,
    fields: FieldMappingRow[],
    record: FeishuRecord
  ): Promise<void> {
    const rawPersonValue = this.value(record, fields, 'personName');
    const rawPersonName = this.text(rawPersonValue);
    const personName = this.liveCellParser.normalizePersonName(rawPersonName);
    const role = this.role(this.text(this.value(record, fields, 'role')));
    const employmentStatus =
      this.text(this.value(record, fields, 'employmentStatus')) || null;
    const month = this.month(
      this.value(record, fields, 'month'),
      this.rule(fields, 'month')
    );
    if (!personName || !role || !month) {
      throw new Error('人员姓名、岗位或月份无法解析');
    }
    const personId = await this.resolveOrCreateScheduledPerson(
      rawPersonName,
      personName,
      role,
      mapping.table_id,
      this.personObject(rawPersonValue)?.open_id
    );
    const templates = await this.shiftTemplates();
    const dayMappings = fields.filter((field) => field.local_field_name.startsWith('day.'));
    for (const dayField of dayMappings) {
      const raw = record.fields[dayField.feishu_field_name];
      if (raw === null || raw === undefined || this.text(raw) === '') continue;
      const rawShiftValue = this.text(raw);
      const day = Number(dayField.local_field_name.slice(4));
      const date = this.date(month.year, month.month, day);
      if (!date) continue;
      const parsed = this.shiftParser.parse(date, rawShiftValue, templates);
      const status = personId ? parsed.status : 'NEEDS_CONFIRMATION';
      const schedule = await this.db.query<{ id: string; source_type: string }>(
        `
          INSERT INTO staff_daily_schedules(
            person_id, schedule_date, role, employment_status,
            raw_person_name, raw_shift_value,
            shift_template_id, starts_at, ends_at, is_rest, is_bookable,
            parse_status, parse_message, source_table_id, source_record_id,
            source_date_field_id, source_date_field_name, source_version, raw_data
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
          )
          ON CONFLICT (source_table_id, source_record_id, source_date_field_id)
          DO UPDATE SET person_id=EXCLUDED.person_id, schedule_date=EXCLUDED.schedule_date,
            role=EXCLUDED.role, employment_status=EXCLUDED.employment_status,
            raw_person_name=EXCLUDED.raw_person_name,
            raw_shift_value=EXCLUDED.raw_shift_value,
            shift_template_id=EXCLUDED.shift_template_id,
            starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
            is_rest=EXCLUDED.is_rest, is_bookable=EXCLUDED.is_bookable,
            parse_status=EXCLUDED.parse_status, parse_message=EXCLUDED.parse_message,
            source_version=EXCLUDED.source_version, raw_data=EXCLUDED.raw_data,
            last_synced_at=now(), updated_at=now()
          WHERE staff_daily_schedules.source_type NOT IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          RETURNING id, source_type
        `,
        [
          personId,
          date,
          role,
          employmentStatus,
          rawPersonName,
          rawShiftValue,
          parsed.templateId ?? null,
          parsed.startsAt ?? null,
          parsed.endsAt ?? null,
          parsed.isRest,
          parsed.isBookable && Boolean(personId),
          status,
          personId ? parsed.message ?? null : '人员未唯一匹配，请在人员映射中心确认',
          mapping.table_id,
          record.record_id,
          dayField.feishu_field_id,
          dayField.feishu_field_name,
          record.last_modified_time ?? null,
          JSON.stringify(record.fields)
        ]
      );
      const persistedSchedule =
        schedule.rows[0] ??
        (
          await this.db.query<{ id: string; source_type: string }>(
            `
              SELECT id, source_type
              FROM staff_daily_schedules
              WHERE source_table_id=$1 AND source_record_id=$2
                AND source_date_field_id=$3
            `,
            [mapping.table_id, record.record_id, dayField.feishu_field_id]
          )
        ).rows[0];
      if (!persistedSchedule) throw new Error('人员日排班写入失败');
      if (['LOCAL', 'LOCAL_OVERRIDE', 'AUTO_PLAN'].includes(persistedSchedule.source_type)) continue;
      const scheduleId = persistedSchedule.id;
      await this.db.query(
        'DELETE FROM staff_schedule_segments WHERE schedule_id=$1',
        [scheduleId]
      );
      for (const [index, segment] of (parsed.segments ?? []).entries()) {
        await this.db.query(
          `
            INSERT INTO staff_schedule_segments(
              schedule_id, segment_index, starts_at, ends_at, bookable
            )
            VALUES ($1,$2,$3,$4,$5)
          `,
          [
            scheduleId,
            index,
            segment.startsAt,
            segment.endsAt,
            segment.bookable && Boolean(personId)
          ]
        );
      }
    }
  }

  private async processLiveMonthlyRecord(
    mapping: TableMappingRow,
    fields: FieldMappingRow[],
    record: FeishuRecord
  ): Promise<void> {
    const roomName = this.text(this.value(record, fields, 'roomName'));
    const slot = this.text(this.value(record, fields, 'slot'));
    const month = this.month(
      this.value(record, fields, 'month'),
      this.rule(fields, 'month')
    );
    if (!roomName || !slot || !month) {
      throw new Error('直播间、时段或月份无法解析');
    }
    const roomId = await this.upsertRoom(roomName);
    const dayMappings = fields.filter((field) => field.local_field_name.startsWith('day.'));
    for (const dayField of dayMappings) {
      const raw = record.fields[dayField.feishu_field_name];
      const day = Number(dayField.local_field_name.slice(4));
      const date = this.date(month.year, month.month, day);
      if (!date) continue;
      const deletedSlots = await this.db.query<{ id: string }>(
        `
          DELETE FROM live_slot_schedules
          WHERE source_table_id=$1 AND source_record_id=$2 AND source_date_field_id=$3
          RETURNING id
        `,
        [mapping.table_id, record.record_id, dayField.feishu_field_id]
      );
      await this.invalidateLiveSessions(
        deletedSlots.rows.map((deleted) => deleted.id)
      );
      if (raw === null || raw === undefined || this.text(raw) === '') continue;
      const rawLiveValue = this.text(raw);
      const range = this.slotRange(date, slot);
      if (!range) throw new Error(`无法识别直播小时段“${slot}”`);
      const entries = this.liveCellParser.parse(rawLiveValue);
      for (const entry of entries) {
        let anchorId = entry.normalizedName
          ? await this.resolvePerson(null, entry.normalizedName)
          : null;
        if (!anchorId && entry.normalizedName) {
          anchorId = await this.resolveOrCreateScheduledPerson(
            entry.rawName,
            entry.normalizedName,
            'ANCHOR',
            mapping.table_id
          );
        }
        await this.insertLiveSlot(
          mapping,
          record,
          dayField,
          date,
          range,
          roomId,
          anchorId,
          entry,
          rawLiveValue
        );
      }
    }
  }

  private async invalidateLiveSessions(sourceSlotIds: string[]): Promise<void> {
    if (!sourceSlotIds.length) return;
    await this.db.query(
      `
        UPDATE live_sessions session
        SET status='RESCHEDULED', updated_at=now()
        WHERE session.status='SCHEDULED'
          AND session.source_type NOT IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND session.source_slot_ids && $1::uuid[]
          AND EXISTS (
            SELECT 1 FROM makeup_appointments appointment
            WHERE appointment.live_session_id=session.id
          )
      `,
      [sourceSlotIds]
    );
    await this.db.query(
      `
        DELETE FROM live_sessions session
        WHERE session.source_slot_ids && $1::uuid[]
          AND session.source_type NOT IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          AND NOT EXISTS (
            SELECT 1 FROM makeup_appointments appointment
            WHERE appointment.live_session_id=session.id
          )
      `,
      [sourceSlotIds]
    );
  }

  private async insertLiveSlot(
    mapping: TableMappingRow,
    record: FeishuRecord,
    dayField: FieldMappingRow,
    date: string,
    range: { start: string; end: string },
    roomId: string,
    anchorId: string | null,
    entry: ParsedLiveCellEntry,
    raw: unknown
  ): Promise<void> {
    await this.db.query(
      `
        INSERT INTO live_slot_schedules(
          schedule_date, room_id, anchor_id, raw_anchor_name, employment_type,
          starts_at, ends_at, raw_value, schedule_type, exception_type,
          extra_minutes, missing_minutes, makeup_required, parse_status,
          parse_message, source_table_id, source_record_id, source_date_field_id,
          source_version, raw_data
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      `,
      [
        date,
        roomId,
        anchorId,
        entry.normalizedName ?? null,
        entry.employmentType ?? null,
        range.start,
        range.end,
        this.text(raw),
        entry.scheduleType,
        entry.exceptionType ?? null,
        entry.extraMinutes,
        entry.missingMinutes,
        entry.scheduleType === 'LIVE' && !entry.exceptionType,
        anchorId || entry.exceptionType ? entry.parseStatus : 'NEEDS_CONFIRMATION',
        !anchorId && entry.normalizedName ? '主播未唯一匹配' : null,
        mapping.table_id,
        record.record_id,
        dayField.feishu_field_id,
        record.last_modified_time ?? null,
        JSON.stringify({ entry, fields: record.fields })
      ]
    );
  }

  private async processPersonRecord(
    _mapping: TableMappingRow,
    fields: FieldMappingRow[],
    record: FeishuRecord
  ): Promise<void> {
    const name = this.text(this.value(record, fields, 'personName'));
    if (!name) throw new Error('人员姓名为空');
    const user = this.personObject(this.value(record, fields, 'feishuUser'));
    const existing = await this.resolvePerson(user, name);
    if (!existing) {
      await this.db.query(
        `
          INSERT INTO people(
            display_name, employee_no, feishu_user_id, feishu_open_id,
            email, phone, login_allowed, metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,false,$7)
        `,
        [
          name,
          this.text(this.value(record, fields, 'employeeNo')) || null,
          user?.user_id ?? null,
          user?.open_id ?? null,
          this.text(this.value(record, fields, 'email')) || null,
          this.text(this.value(record, fields, 'phone')) || null,
          JSON.stringify({ sourceRecordId: record.record_id })
        ]
      );
    }
  }

  private async processRemoteAppointment(
    mapping: TableMappingRow,
    fields: FieldMappingRow[],
    record: FeishuRecord
  ): Promise<void> {
    const start = this.dateTime(this.value(record, fields, 'plannedStartAt'));
    const end = this.dateTime(this.value(record, fields, 'plannedEndAt'));
    const anchorName = this.text(this.value(record, fields, 'anchor'));
    const artistName = this.text(this.value(record, fields, 'makeupArtist'));
    const roomName = this.text(this.value(record, fields, 'roomName'));
    if (!start || !end || !anchorName || !artistName || !roomName) {
      throw new Error('预约缺少时间、主播、化妆师或直播间映射');
    }
    const [anchorId, artistId] = await Promise.all([
      this.resolvePerson(this.value(record, fields, 'anchor'), anchorName),
      this.resolvePerson(this.value(record, fields, 'makeupArtist'), artistName)
    ]);
    if (!anchorId || !artistId) throw new Error('预约人员未唯一匹配');
    const roomId = await this.upsertRoom(roomName);
    const existingMap = await this.db.query<{ local_resource_id: string }>(
      `
        SELECT local_resource_id FROM external_record_mappings
        WHERE source_system='FEISHU' AND source_table_id=$1 AND source_record_id=$2
          AND local_resource_type='MAKEUP_APPOINTMENTS'
      `,
      [mapping.table_id, record.record_id]
    );
    if (existingMap.rows[0]?.local_resource_id) {
      const current = await this.db.query<{ status: string }>(
        'SELECT status FROM makeup_appointments WHERE id=$1',
        [existingMap.rows[0].local_resource_id]
      );
      if (['IN_PROGRESS', 'COMPLETED'].includes(current.rows[0]?.status ?? '')) {
        throw new Error('飞书修改不能覆盖妆造中或已完成预约');
      }
      await this.db.query(
        `
          UPDATE makeup_appointments
          SET makeup_artist_id=$2, room_id=$3, planned_start_at=$4,
              planned_end_at=$5, data_version=data_version+1,
              source_version=$6, last_synced_at=now(), updated_at=now()
          WHERE id=$1
        `,
        [
          existingMap.rows[0].local_resource_id,
          artistId,
          roomId,
          start,
          end,
          record.last_modified_time ?? null
        ]
      );
      return;
    }
    const session = await this.db.query<{ id: string; starts_at: Date }>(
      `
        SELECT id, starts_at FROM live_sessions
        WHERE anchor_id=$1 AND room_id=$2 AND status='SCHEDULED'
          AND starts_at > $3::timestamptz
          AND starts_at::date = $3::timestamptz AT TIME ZONE 'Asia/Shanghai'
        ORDER BY starts_at LIMIT 1
      `,
      [anchorId, roomId, end]
    );
    if (!session.rows[0]) throw new Error('预约无法关联主播连续直播班次');
    const service = await this.db.query<{ id: string }>(
      `SELECT id FROM makeup_service_types WHERE code='FULL_LIVE_LOOK'`
    );
    const id = randomUUID();
    try {
      await this.db.query(
        `
          INSERT INTO makeup_appointments(
            id, appointment_no, status, makeup_date,
            subject_type, subject_person_id,
            anchor_id, live_session_id, room_id,
            requester_id, requester_role, makeup_artist_id,
            service_type_id, planned_start_at, planned_end_at, planned_minutes,
            location, source_type, source_table_id, source_record_id,
            source_version, last_synced_at
          )
          VALUES ($1,$2,'BOOKED',($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
            'ANCHOR',$4,$4,$5,$6,$4,'ANCHOR',$7,$8,$3,$9,
            EXTRACT(EPOCH FROM ($9::timestamptz-$3::timestamptz))/60,
            $10,'FEISHU',$11,$12,$13,now())
        `,
        [
          id,
          `FS-${record.record_id}`,
          start,
          anchorId,
          session.rows[0].id,
          roomId,
          artistId,
          service.rows[0]!.id,
          end,
          roomName,
          mapping.table_id,
          record.record_id,
          record.last_modified_time ?? null
        ]
      );
      await this.db.query(
        `
          INSERT INTO external_record_mappings(
            source_table_id, source_record_id, local_resource_type,
            local_resource_id, content_hash, raw_data
          )
          VALUES ($1,$2,'MAKEUP_APPOINTMENTS',$3,'pending',$4)
          ON CONFLICT (source_system, source_table_id, source_record_id, local_resource_type)
          DO UPDATE SET local_resource_id=EXCLUDED.local_resource_id
        `,
        [mapping.table_id, record.record_id, id, JSON.stringify(record)]
      );
    } catch (error) {
      if (error instanceof DatabaseError && error.code === '23P01') {
        throw new Error('飞书预约与本地有效预约时间冲突');
      }
      throw error;
    }
  }

  private async rebuildLiveSessions(mapping: TableMappingRow): Promise<void> {
    const tableId = mapping.table_id;
    const rows = await this.db.query<{
      id: string;
      room_id: string;
      anchor_id: string;
      starts_at: Date;
      ends_at: Date;
      schedule_type: string;
      makeup_required: boolean;
    }>(
      `
        SELECT id, room_id, anchor_id, starts_at, ends_at, schedule_type, makeup_required
        FROM live_slot_schedules
        WHERE source_table_id=$1 AND anchor_id IS NOT NULL AND exception_type IS NULL
          AND parse_status='SUCCESS'
        ORDER BY room_id, anchor_id, starts_at
      `,
      [tableId]
    );
    const groups = new Map<string, MergeableSlot[]>();
    for (const row of rows.rows) {
      const key = `${row.room_id}|${row.anchor_id}|${row.schedule_type}`;
      const group = groups.get(key) ?? [];
      group.push({
        id: row.id,
        roomId: row.room_id,
        anchorId: row.anchor_id,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        scheduleType: row.schedule_type,
        makeupRequired: row.makeup_required
      });
      groups.set(key, group);
    }
    for (const slots of groups.values()) {
      for (const session of this.sessionMerger.merge(slots)) {
        await this.db.query(
          `
            INSERT INTO live_sessions(
              room_id, anchor_id, starts_at, ends_at, schedule_type,
              makeup_required, source_slot_ids, source_fingerprint
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (source_fingerprint) DO UPDATE
            SET source_slot_ids=EXCLUDED.source_slot_ids,
                makeup_required=EXCLUDED.makeup_required, updated_at=now()
            WHERE live_sessions.source_type NOT IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
          `,
          [
            session.roomId,
            session.anchorId,
            session.startsAt,
            session.endsAt,
            session.scheduleType,
            session.makeupRequired,
            session.sourceSlotIds,
            session.fingerprint
          ]
        );
      }
    }
    await this.refreshAnchorOverlapConflicts(mapping);
  }

  private async refreshAnchorOverlapConflicts(
    mapping: TableMappingRow
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE sync_conflicts
        SET status='RESOLVED', resolution='CONDITION_CLEARED',
            resolved_at=now(), updated_at=now()
        WHERE table_mapping_id=$1 AND conflict_type='ANCHOR_SCHEDULE_OVERLAP'
          AND status='OPEN'
      `,
      [mapping.id]
    );
    await this.db.query(
      `
        UPDATE risk_items
        SET status='RESOLVED', resolution_note='飞书同步后排班重叠已解除',
            resolved_at=now(), updated_at=now()
        WHERE risk_type='ANCHOR_SCHEDULE_OVERLAP'
          AND source_type='FEISHU_SYNC'
          AND metadata->>'sourceTableId'=$1
          AND status IN ('OPEN','ACKNOWLEDGED')
      `,
      [mapping.table_id]
    );
    const overlaps = await this.db.query<{
      own_id: string;
      other_id: string;
      anchor_id: string;
      anchor_name: string;
      own_room_id: string;
      own_room_name: string;
      other_room_id: string;
      other_room_name: string;
      own_start: Date;
      own_end: Date;
      other_start: Date;
      other_end: Date;
    }>(
      `
        SELECT own.id AS own_id, other.id AS other_id,
               own.anchor_id, anchor.display_name AS anchor_name,
               own.room_id AS own_room_id, own_room.name AS own_room_name,
               other.room_id AS other_room_id, other_room.name AS other_room_name,
               own.starts_at AS own_start, own.ends_at AS own_end,
               other.starts_at AS other_start, other.ends_at AS other_end
        FROM live_sessions own
        JOIN live_sessions other ON own.id<other.id
          AND own.anchor_id=other.anchor_id
          AND own.starts_at<other.ends_at AND own.ends_at>other.starts_at
        JOIN people anchor ON anchor.id=own.anchor_id
        JOIN rooms own_room ON own_room.id=own.room_id
        JOIN rooms other_room ON other_room.id=other.room_id
        WHERE own.source_type='FEISHU' AND other.source_type='FEISHU'
          AND own.status='SCHEDULED' AND other.status='SCHEDULED'
          AND own.cancelled_at IS NULL AND other.cancelled_at IS NULL
      `
    );
    for (const overlap of overlaps.rows) {
      const recordId = `overlap:${overlap.own_id}:${overlap.other_id}`;
      const remote = {
        anchorId: overlap.anchor_id,
        anchorName: overlap.anchor_name,
        sessions: [
          {
            id: overlap.own_id,
            roomId: overlap.own_room_id,
            roomName: overlap.own_room_name,
            startsAt: overlap.own_start,
            endsAt: overlap.own_end
          },
          {
            id: overlap.other_id,
            roomId: overlap.other_room_id,
            roomName: overlap.other_room_name,
            startsAt: overlap.other_start,
            endsAt: overlap.other_end
          }
        ]
      };
      await this.recordConflict(
        mapping,
        recordId,
        'ANCHOR_SCHEDULE_OVERLAP',
        remote,
        `${overlap.anchor_name}在${overlap.own_room_name}与${overlap.other_room_name}存在重叠直播时段`
      );
      await this.db.query(
        `
          INSERT INTO risk_items(
            risk_type, severity, title, description, live_session_id,
            room_id, person_id, suggestion, source_type, fingerprint,
            due_at, metadata
          )
          VALUES (
            'ANCHOR_SCHEDULE_OVERLAP','URGENT','主播直播排班重叠',$1,$2,$3,$4,
            '请在飞书正式排班表中调整冲突时段后重新同步。',
            'FEISHU_SYNC',$5,$6,$7
          )
          ON CONFLICT (fingerprint) DO UPDATE SET
            description=EXCLUDED.description, due_at=EXCLUDED.due_at,
            status='OPEN', resolved_at=NULL, resolution_note=NULL,
            metadata=EXCLUDED.metadata, updated_at=now()
        `,
        [
          `${overlap.anchor_name}同时出现在${overlap.own_room_name}和${overlap.other_room_name}。`,
          overlap.own_id,
          overlap.own_room_id,
          overlap.anchor_id,
          `ANCHOR_SCHEDULE_OVERLAP:${overlap.own_id}:${overlap.other_id}`,
          overlap.own_start,
          JSON.stringify({
            sourceTableId: mapping.table_id,
            otherSessionId: overlap.other_id,
            otherRoomId: overlap.other_room_id
          })
        ]
      );
    }
  }

  private async resolvePerson(
    rawPerson: unknown,
    name: string
  ): Promise<string | null> {
    const person = this.personObject(rawPerson);
    if (person?.open_id || person?.user_id) {
      const byId = await this.db.query<{ id: string }>(
        `
          SELECT id FROM people
          WHERE ($1::text IS NOT NULL AND feishu_open_id=$1)
             OR ($2::text IS NOT NULL AND feishu_user_id=$2)
        `,
        [person.open_id ?? null, person.user_id ?? null]
      );
      if (byId.rowCount === 1) return byId.rows[0]!.id;
    }
    const byName = await this.db.query<{ id: string }>(
      `
        SELECT id FROM people
        WHERE archived_at IS NULL
          AND (display_name=$1 OR legal_name=$1 OR $1=ANY(aliases))
        LIMIT 2
      `,
      [name]
    );
    return byName.rowCount === 1 ? byName.rows[0]!.id : null;
  }

  private async resolveOrCreateScheduledPerson(
    rawName: string,
    normalizedName: string,
    role: PersonRole,
    sourceTableId: string,
    feishuOpenId?: string
  ): Promise<string | null> {
    return this.db.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`${role}:${normalizedName}`]
      );
      if (feishuOpenId) {
        const byFeishuId = await client.query<{ id: string }>(
          'SELECT id FROM people WHERE feishu_open_id=$1 LIMIT 1',
          [feishuOpenId]
        );
        if (byFeishuId.rows[0]) {
          await client.query(
            `
              INSERT INTO person_roles(person_id, role, enabled)
              VALUES ($1,$2,true)
              ON CONFLICT (person_id, role)
              DO UPDATE SET enabled=true, updated_at=now()
            `,
            [byFeishuId.rows[0].id, role]
          );
          return byFeishuId.rows[0].id;
        }
      }
      const matched = await client.query<{ id: string }>(
        `
          SELECT DISTINCT p.id
          FROM people p
          JOIN person_roles pr ON pr.person_id=p.id
          WHERE p.archived_at IS NULL
            AND pr.role=$2
            AND pr.enabled
            AND (
              p.display_name=$1
              OR p.legal_name=$1
              OR $1=ANY(p.aliases)
            )
          LIMIT 2
        `,
        [normalizedName, role]
      );
      if (matched.rowCount === 1) {
        if (feishuOpenId) {
          await client.query(
            `
              UPDATE people
              SET feishu_open_id=COALESCE(feishu_open_id,$2), updated_at=now()
              WHERE id=$1
            `,
            [matched.rows[0]!.id, feishuOpenId]
          );
        }
        return matched.rows[0]!.id;
      }
      if ((matched.rowCount ?? 0) > 1) return null;

      const created = await client.query<{ id: string }>(
        `
          INSERT INTO people(
            display_name, aliases, feishu_open_id, login_allowed, metadata
          )
          VALUES ($1,$2,$3,false,$4)
          RETURNING id
        `,
        [
          normalizedName,
          rawName === normalizedName ? [] : [rawName],
          feishuOpenId ?? null,
          JSON.stringify({
            identityStatus: 'UNBOUND',
            matchBasis: 'SCHEDULE_NAME_AND_ROLE',
            sourceSystem: 'FEISHU',
            sourceTableId
          })
        ]
      );
      const personId = created.rows[0]!.id;
      await client.query(
        `
          INSERT INTO person_roles(person_id, role, enabled)
          VALUES ($1,$2,true)
          ON CONFLICT (person_id, role)
          DO UPDATE SET enabled=true, updated_at=now()
        `,
        [personId, role]
      );
      return personId;
    });
  }

  private personObject(
    value: unknown
  ): { open_id?: string; user_id?: string; name?: string } | null {
    const candidate = Array.isArray(value) ? (value as unknown[])[0] : value;
    if (!candidate || typeof candidate !== 'object') return null;
    const item = candidate as Record<string, unknown>;
    const openId =
      typeof item.open_id === 'string'
        ? item.open_id
        : typeof item.token === 'string' && item.token.startsWith('ou_')
          ? item.token
          : undefined;
    return {
      ...(openId ? { open_id: openId } : {}),
      ...(typeof item.user_id === 'string' ? { user_id: item.user_id } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {})
    };
  }

  private async upsertRoom(name: string): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `
        INSERT INTO rooms(name, room_type) VALUES ($1,'LIVE_ROOM')
        ON CONFLICT (name) DO UPDATE SET updated_at=now()
        RETURNING id
      `,
      [name]
    );
    return result.rows[0]!.id;
  }

  private async shiftTemplates(): Promise<ShiftTemplateInput[]> {
    const result = await this.db.query<{
      id: string;
      name: string;
      start_time: string | null;
      end_time: string | null;
      duration_minutes: number | null;
      crosses_midnight: boolean;
      bookable: boolean;
      confirmation_required: boolean;
      segments: Array<{ startTime: string; endTime: string }> | null;
      aliases: string[];
    }>(
      `
        SELECT template.*,
               COALESCE(
                 array_agg(alias.alias ORDER BY alias.alias)
                   FILTER (WHERE alias.enabled),
                 ARRAY[]::text[]
               ) AS aliases
        FROM shift_templates template
        LEFT JOIN shift_template_aliases alias
          ON alias.shift_template_id=template.id
        WHERE template.enabled
        GROUP BY template.id
      `
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMinutes: row.duration_minutes,
      crossesMidnight: row.crosses_midnight,
      bookable: row.bookable,
      confirmationRequired: row.confirmation_required,
      aliases: row.aliases,
      segments: row.segments ?? []
    }));
  }

  private async recordConflict(
    mapping: TableMappingRow,
    recordId: string,
    type: string,
    remote: unknown,
    message: string
  ): Promise<void> {
    const updated = await this.db.query(
      `
        UPDATE sync_conflicts
        SET table_mapping_id=$1, remote_data=$5, difference_data=$6,
            updated_at=now()
        WHERE source_table_id=$2 AND source_record_id=$3
          AND conflict_type=$4 AND status='OPEN'
        RETURNING id
      `,
      [
        mapping.id,
        mapping.table_id,
        recordId,
        type,
        JSON.stringify(remote),
        JSON.stringify({ message })
      ]
    );
    if (updated.rows[0]) return;
    await this.db.query(
      `
        INSERT INTO sync_conflicts(
          table_mapping_id, source_table_id, source_record_id,
          conflict_type, remote_data, difference_data
        )
        VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        mapping.id,
        mapping.table_id,
        recordId,
        type,
        JSON.stringify(remote),
        JSON.stringify({ message })
      ]
    );
  }

  private value(
    record: FeishuRecord,
    fields: FieldMappingRow[],
    localName: string
  ): unknown {
    const mapping = fields.find((field) => field.local_field_name === localName);
    return mapping ? record.fields[mapping.feishu_field_name] : undefined;
  }

  private rule(
    fields: FieldMappingRow[],
    localName: string
  ): Record<string, unknown> {
    return (
      fields.find((field) => field.local_field_name === localName)?.transform_rule ??
      {}
    );
  }

  private text(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            const object = item as Record<string, unknown>;
            const candidate = object.text ?? object.name ?? object.id;
            return typeof candidate === 'string' || typeof candidate === 'number'
              ? String(candidate)
              : '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const candidate = object.text ?? object.name ?? object.value;
      return typeof candidate === 'string' || typeof candidate === 'number'
        ? String(candidate).trim()
        : '';
    }
    return '';
  }

  private role(value: string): PersonRole | null {
    if (/主播/.test(value)) return 'ANCHOR';
    if (/达人/.test(value)) return 'TALENT';
    if (/编导/.test(value)) return 'DIRECTOR';
    if (/场控/.test(value)) return 'FIELD_CONTROL';
    if (/妆|化妆/.test(value)) return 'MAKEUP_ARTIST';
    if (/主管/.test(value)) return 'LIVE_SUPERVISOR';
    return null;
  }

  private month(
    value: unknown,
    rule: Record<string, unknown>
  ): { year: number; month: number } | null {
    if (typeof value === 'number' && value > 10_000_000_000) {
      const date = new Date(value);
      return {
        year: Number(
          new Intl.DateTimeFormat('en', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric'
          }).format(date)
        ),
        month: Number(
          new Intl.DateTimeFormat('en', {
            timeZone: 'Asia/Shanghai',
            month: 'numeric'
          }).format(date)
        )
      };
    }
    const text = this.text(value);
    const full = text.match(/(20\d{2})[-年/](\d{1,2})/);
    if (full) return { year: Number(full[1]), month: Number(full[2]) };
    const short = text.match(/(\d{1,2})\s*月?/);
    if (!short) return null;
    const configuredYear = Number(rule.defaultYear ?? new Date().getFullYear());
    return { year: configuredYear, month: Number(short[1]) };
  }

  private date(year: number, month: number, day: number): string | null {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  private slotRange(
    date: string,
    raw: string
  ): { start: string; end: string } | null {
    const normalized = raw
      .replace(/[：]/g, ':')
      .replace(/[—–~～至]/g, '-')
      .replace(/时段/g, '')
      .replace(/\s+/g, '');
    const match = normalized.match(
      /^([01]?\d|2[0-3])(?::([0-5]\d))?-(0?\d|1\d|2[0-4])(?::([0-5]\d))?$/
    );
    if (!match) return null;
    const startHour = Number(match[1]);
    const endHour = Number(match[3]);
    const nextDay = endHour === 24 || endHour <= startHour;
    const endDate = nextDay ? this.addDay(date) : date;
    return {
      start: `${date}T${String(startHour).padStart(2, '0')}:${match[2] ?? '00'}:00+08:00`,
      end: `${endDate}T${String(endHour === 24 ? 0 : endHour).padStart(2, '0')}:${match[4] ?? '00'}:00+08:00`
    };
  }

  private addDay(date: string): string {
    const value = new Date(`${date}T00:00:00+08:00`);
    value.setUTCDate(value.getUTCDate() + 1);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(value);
  }

  private dateTime(value: unknown): string | null {
    if (typeof value === 'number') return new Date(value).toISOString();
    const text = this.text(value);
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
}
