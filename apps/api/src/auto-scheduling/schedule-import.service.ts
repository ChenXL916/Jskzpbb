import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CurrentUser } from '@jishi/contracts';
import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export const scheduleImportTypes = [
  'ANCHORS',
  'ELIGIBILITY',
  'AVAILABILITY',
  'ABILITY',
  'COVERAGE'
] as const;
export type ScheduleImportType = (typeof scheduleImportTypes)[number];

export interface ScheduleImportFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

type ImportRow = Record<string, string>;
type NormalizedRow = Record<string, string | number | boolean | null>;

interface ValidatedRow {
  rowNumber: number;
  source: ImportRow;
  normalized: NormalizedRow;
  errors: string[];
}

interface RollbackOperation {
  table: 'people' | 'person_roles' | 'anchor_scheduling_profiles' |
    'anchor_room_eligibility' | 'anchor_availability_exceptions' |
    'anchor_performance_scores' | 'room_coverage_templates' |
    'room_coverage_template_slots';
  key: Record<string, string>;
  before: Record<string, unknown> | null;
}

const requiredHeaders: Record<ScheduleImportType, string[]> = {
  ANCHORS: ['display_name', 'employment_type', 'employment_status'],
  ELIGIBILITY: ['room_name', 'eligible'],
  AVAILABILITY: ['starts_at', 'ends_at', 'availability_type'],
  ABILITY: [
    'room_name', 'period_start', 'period_end', 'effective_hours',
    'capability_score', 'confidence_grade', 'source_document'
  ],
  COVERAGE: [
    'room_name', 'template_name', 'date_type', 'start_time', 'end_time',
    'block_minutes', 'required_anchor_count'
  ]
};

@Injectable()
export class ScheduleImportService {
  constructor(private readonly db: DatabaseService) {}

  async list() {
    const result = await this.db.query(
      `SELECT job.*, creator.display_name AS created_by_name
       FROM schedule_import_jobs job
       LEFT JOIN people creator ON creator.id=job.created_by
       ORDER BY job.created_at DESC LIMIT 100`
    );
    return result.rows;
  }

  async get(id: string) {
    const job = (
      await this.db.query(
        `SELECT job.*, creator.display_name AS created_by_name
         FROM schedule_import_jobs job
         LEFT JOIN people creator ON creator.id=job.created_by
         WHERE job.id=$1`,
        [id]
      )
    ).rows[0];
    if (!job) throw new NotFoundException('导入任务不存在');
    const items = await this.db.query(
      `SELECT * FROM schedule_import_job_items
       WHERE job_id=$1 ORDER BY row_number`,
      [id]
    );
    return { ...job, items: items.rows };
  }

  async upload(user: CurrentUser, typeValue: string, file?: ScheduleImportFile) {
    const type = this.parseType(typeValue);
    if (!file) throw new BadRequestException('请选择要导入的 CSV 或 XLSX 文件');
    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('导入文件不能超过 10MB');
    }
    const extension = file.originalname.toLowerCase().split('.').pop();
    if (!['csv', 'xlsx'].includes(extension ?? '')) {
      throw new BadRequestException('只支持 CSV 或 XLSX 文件');
    }
    const rows = extension === 'csv'
      ? this.parseCsv(file.buffer.toString('utf8'))
      : await this.parseWorkbook(file.buffer, type);
    if (rows.length === 0) throw new BadRequestException('导入文件没有数据行');
    if (rows.length > 5000) throw new BadRequestException('单次导入最多 5000 行');

    const headers = Object.keys(rows[0] ?? {});
    const missing = requiredHeaders[type].filter((header) => !headers.includes(header));
    if (missing.length) {
      throw new BadRequestException(`缺少必填列：${missing.join('、')}`);
    }
    const validated = rows.map((row, index) => this.validate(type, row, index + 2));
    const errors = validated
      .filter((item) => item.errors.length)
      .slice(0, 100)
      .map((item) => ({ rowNumber: item.rowNumber, errors: item.errors }));
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const jobId: string = await this.db.transaction<string>(async (client): Promise<string> => {
      const createdJobId = (
        await client.query<{ id: string }>(
          `INSERT INTO schedule_import_jobs(
             import_type,source_file_name,source_sha256,status,total_rows,
             valid_rows,error_rows,validation_errors,created_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            type, file.originalname, hash,
            errors.length ? 'UPLOADED' : 'READY', validated.length,
            validated.length - validated.filter((item) => item.errors.length).length,
            validated.filter((item) => item.errors.length).length,
            JSON.stringify(errors), user.personId
          ]
        )
      ).rows[0]!.id;
      for (const item of validated) {
        await client.query(
          `INSERT INTO schedule_import_job_items(
             job_id,row_number,source_data,normalized_data,status,error_code,error_message
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            createdJobId, item.rowNumber, JSON.stringify(item.source),
            JSON.stringify(item.normalized), item.errors.length ? 'ERROR' : 'VALID',
            item.errors.length ? 'VALIDATION_ERROR' : null,
            item.errors.join('；') || null
          ]
        );
      }
      await this.audit(client, user.personId, 'VALIDATE_SCHEDULE_IMPORT', createdJobId, null, {
        importType: type,
        fileName: file.originalname,
        totalRows: validated.length,
        errorRows: validated.filter((item) => item.errors.length).length
      });
      return createdJobId;
    });
    return this.get(jobId);
  }

  async commit(user: CurrentUser, id: string) {
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<{
          id: string; import_type: ScheduleImportType; status: string; error_rows: number;
        }>('SELECT id,import_type,status,error_rows FROM schedule_import_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!job) throw new NotFoundException('导入任务不存在');
      if (job.status !== 'READY') {
        throw new BadRequestException('只有校验通过且未提交的任务可以导入');
      }
      if (job.error_rows > 0) throw new BadRequestException('导入任务仍有错误行');
      await client.query(`UPDATE schedule_import_jobs SET status='IMPORTING' WHERE id=$1`, [id]);
      const rows = await client.query<{
        id: string; row_number: number; normalized_data: NormalizedRow;
      }>(
        `SELECT id,row_number,normalized_data FROM schedule_import_job_items
         WHERE job_id=$1 AND status='VALID' ORDER BY row_number`,
        [id]
      );
      const rollback: RollbackOperation[] = [];
      for (const item of rows.rows) {
        const resource = await this.applyRow(client, job.import_type, item.normalized_data, rollback);
        await client.query(
          `UPDATE schedule_import_job_items
           SET status='IMPORTED',resource_type=$2,resource_id=$3 WHERE id=$1`,
          [item.id, resource.type, resource.id]
        );
      }
      await client.query(
        `UPDATE schedule_import_jobs
         SET status='COMPLETED',rollback_data=$2,completed_at=now() WHERE id=$1`,
        [id, JSON.stringify({ operations: rollback })]
      );
      await this.audit(client, user.personId, 'COMMIT_SCHEDULE_IMPORT', id, null, {
        importType: job.import_type,
        importedRows: rows.rowCount ?? rows.rows.length
      });
      return { id, status: 'COMPLETED', importedRows: rows.rowCount ?? rows.rows.length };
    });
  }

  async rollback(user: CurrentUser, id: string) {
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<{ status: string; rollback_data: { operations?: RollbackOperation[] } }>(
          'SELECT status,rollback_data FROM schedule_import_jobs WHERE id=$1 FOR UPDATE', [id]
        )
      ).rows[0];
      if (!job) throw new NotFoundException('导入任务不存在');
      if (job.status !== 'COMPLETED') throw new BadRequestException('只有已完成任务可以回滚');
      const operations = [...(job.rollback_data.operations ?? [])].reverse();
      for (const operation of operations) await this.rollbackOperation(client, operation);
      await client.query(`UPDATE schedule_import_job_items SET status='ROLLED_BACK' WHERE job_id=$1 AND status='IMPORTED'`, [id]);
      await client.query(`UPDATE schedule_import_jobs SET status='ROLLED_BACK' WHERE id=$1`, [id]);
      await this.audit(client, user.personId, 'ROLLBACK_SCHEDULE_IMPORT', id, null, { operationCount: operations.length });
      return { id, status: 'ROLLED_BACK', operationCount: operations.length };
    });
  }

  private parseType(value: string): ScheduleImportType {
    const normalized = value.toUpperCase() as ScheduleImportType;
    if (!scheduleImportTypes.includes(normalized)) throw new BadRequestException('不支持的导入类型');
    return normalized;
  }

  private parseCsv(content: string): ImportRow[] {
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return [];
    const matrix = lines.map((line) => this.splitCsvLine(line));
    const headers = matrix[0]!.map((cell) => cell.trim());
    return matrix.slice(1).map((cells) => Object.fromEntries(
      headers.map((header, index) => [header, cells[index]?.trim() ?? ''])
    ));
  }

  private splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (character === '"' && line[index + 1] === '"' && quoted) {
        value += '"'; index += 1;
      } else if (character === '"') quoted = !quoted;
      else if (character === ',' && !quoted) { result.push(value); value = ''; }
      else value += character;
    }
    result.push(value);
    return result;
  }

  private async parseWorkbook(buffer: Buffer, type: ScheduleImportType): Promise<ImportRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheetAliases: Record<ScheduleImportType, string[]> = {
      ANCHORS: ['anchors', '主播'], ELIGIBILITY: ['eligibility', '直播间资格'],
      AVAILABILITY: ['availability', '可用性'], ABILITY: ['ability', '能力'],
      COVERAGE: ['coverage', '覆盖']
    };
    const worksheet = workbook.worksheets.find((sheet) =>
      sheetAliases[type].some((alias) => sheet.name.toLowerCase().includes(alias.toLowerCase()))
    ) ?? workbook.worksheets[0];
    if (!worksheet) return [];
    const headers = (worksheet.getRow(1).values as unknown[])
      .slice(1).map((value) => this.cellText(value).trim());
    const rows: ImportRow[] = [];
    worksheet.eachRow((row, number) => {
      if (number === 1) return;
      const values = (row.values as unknown[]).slice(1);
      const record = Object.fromEntries(headers.map((header, index) => [header, this.cellText(values[index]).trim()]));
      if (Object.values(record).some(Boolean)) rows.push(record);
    });
    return rows;
  }

  private cellText(value: unknown): string {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return `${value}`;
    }
    if (typeof value === 'object') {
      const record = value as { text?: string; result?: unknown; richText?: Array<{ text: string }> };
      if (record.text != null) return record.text;
      if (record.result != null && record.result !== value) return this.cellText(record.result);
      if (record.richText) return record.richText.map((part) => part.text).join('');
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return '';
  }

  private validate(type: ScheduleImportType, row: ImportRow, rowNumber: number): ValidatedRow {
    const normalized: NormalizedRow = { ...row };
    const errors: string[] = [];
    const required = requiredHeaders[type];
    for (const header of required) if (!row[header]?.trim()) errors.push(`${header}不能为空`);
    const needsAnchor = type !== 'COVERAGE';
    if (needsAnchor && !row.anchor_employee_no?.trim() && !row.anchor_display_name?.trim() && !row.display_name?.trim()) {
      errors.push('必须填写主播工号或主播姓名');
    }
    if (type === 'ANCHORS') {
      if (!['FULL_TIME', 'PART_TIME'].includes(row.employment_type ?? '')) errors.push('employment_type只能是FULL_TIME或PART_TIME');
      if (!['ACTIVE', 'TRIAL', 'INACTIVE', 'LEFT'].includes(row.employment_status ?? '')) errors.push('employment_status无效');
      for (const field of ['min_monthly_hours', 'target_monthly_hours', 'max_monthly_hours']) {
        if (row[field] && (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0)) errors.push(`${field}必须为非负数字`);
        normalized[field.replace('_hours', '_minutes')] = row[field] ? Math.round(Number(row[field]) * 60) : null;
      }
      normalized.eligible_for_auto_schedule = this.booleanValue(row.eligible_for_auto_schedule, true);
    }
    if (type === 'ELIGIBILITY') {
      normalized.eligible = this.booleanValue(row.eligible, true);
      normalized.priority = this.integerValue(row.priority, 0, errors, 'priority');
    }
    if (type === 'AVAILABILITY') {
      normalized.starts_at = this.dateTimeValue(row.starts_at, errors, 'starts_at');
      normalized.ends_at = this.dateTimeValue(row.ends_at, errors, 'ends_at');
      if (!['AVAILABLE', 'UNAVAILABLE', 'LEAVE', 'PREFERRED', 'AVOID'].includes(row.availability_type ?? '')) errors.push('availability_type无效');
      if (normalized.starts_at && normalized.ends_at && String(normalized.ends_at) <= String(normalized.starts_at)) errors.push('ends_at必须晚于starts_at');
    }
    if (type === 'ABILITY') {
      for (const field of ['effective_hours', 'capability_score']) {
        normalized[field] = Number(row[field]);
        if (!Number.isFinite(normalized[field]) || Number(normalized[field]) <= 0) errors.push(`${field}必须大于0`);
      }
      if (!['A', 'B', 'C'].includes(row.confidence_grade ?? '')) errors.push('confidence_grade只能是A/B/C');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.period_start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(row.period_end ?? '')) errors.push('能力周期日期格式必须为YYYY-MM-DD');
    }
    if (type === 'COVERAGE') {
      normalized.block_minutes = this.integerValue(row.block_minutes, 180, errors, 'block_minutes');
      normalized.required_anchor_count = this.integerValue(row.required_anchor_count, 1, errors, 'required_anchor_count');
      normalized.priority = this.integerValue(row.priority, 0, errors, 'priority');
      normalized.enabled = this.booleanValue(row.enabled, true);
      normalized.start_minute = this.timeMinute(row.start_time, errors, false);
      normalized.end_minute = this.timeMinute(row.end_time, errors, true);
      if (!['ALL', 'WORKDAY', 'WEEKEND', 'HOLIDAY', 'SPECIAL'].includes(row.date_type ?? '')) errors.push('date_type无效');
      if (row.day_of_week) {
        const day = Number(row.day_of_week);
        if (!Number.isInteger(day) || day < 1 || day > 7) errors.push('day_of_week必须为1至7');
        else normalized.day_of_week = day % 7;
      } else normalized.day_of_week = null;
    }
    return { rowNumber, source: row, normalized, errors };
  }

  private booleanValue(value: string | undefined, fallback: boolean): boolean {
    if (!value) return fallback;
    return ['true', '1', 'yes', '是'].includes(value.trim().toLowerCase());
  }

  private integerValue(value: string | undefined, fallback: number, errors: string[], field: string): number {
    if (!value) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number)) { errors.push(`${field}必须为整数`); return fallback; }
    return number;
  }

  private timeMinute(value: string | undefined, errors: string[], allow24: boolean): number {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
    if (!match) { errors.push('时间格式必须为HH:mm'); return 0; }
    const hour = Number(match[1]); const minute = Number(match[2]);
    if (minute > 59 || hour > (allow24 ? 24 : 23) || (hour === 24 && minute !== 0)) {
      errors.push('时间超出有效范围'); return 0;
    }
    return hour * 60 + minute;
  }

  private dateTimeValue(value: string | undefined, errors: string[], field: string): string | null {
    if (!value) return null;
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
      ? `${normalized}:00`
      : normalized;
    const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(withSeconds) ? withSeconds : `${withSeconds}+08:00`);
    if (Number.isNaN(date.valueOf())) { errors.push(`${field}不是有效日期时间`); return null; }
    return date.toISOString();
  }

  private async applyRow(
    client: PoolClient,
    type: ScheduleImportType,
    row: NormalizedRow,
    rollback: RollbackOperation[]
  ): Promise<{ type: string; id: string }> {
    if (type === 'ANCHORS') return this.applyAnchor(client, row, rollback);
    if (type === 'ELIGIBILITY') return this.applyEligibility(client, row, rollback);
    if (type === 'AVAILABILITY') return this.applyAvailability(client, row, rollback);
    if (type === 'ABILITY') return this.applyAbility(client, row, rollback);
    return this.applyCoverage(client, row, rollback);
  }

  private async applyAnchor(
    client: PoolClient,
    row: NormalizedRow,
    rollback: RollbackOperation[]
  ) {
    const employeeNo = this.optionalString(row.employee_no);
    const displayName = this.requiredString(row.display_name, 'display_name');
    const existing = (
      await client.query<Record<string, unknown>>(
        `SELECT * FROM people
         WHERE ($1::text IS NOT NULL AND employee_no=$1)
            OR ($1::text IS NULL AND display_name=$2 AND archived_at IS NULL)
         ORDER BY employee_no NULLS LAST LIMIT 1 FOR UPDATE`,
        [employeeNo, displayName]
      )
    ).rows[0] ?? null;
    if (!employeeNo && existing) {
      const duplicates = await client.query(
        `SELECT id FROM people WHERE display_name=$1 AND archived_at IS NULL`,
        [displayName]
      );
      if ((duplicates.rowCount ?? 0) > 1) {
        throw new BadRequestException(`主播“${displayName}”存在同名人员，请补充employee_no`);
      }
    }
    let anchorId: string;
    if (existing) {
      anchorId = String(existing.id);
      rollback.push({ table: 'people', key: { id: anchorId }, before: existing });
      await client.query(
        `UPDATE people SET display_name=$2,employee_no=COALESCE($3,employee_no),
           employment_type=$4,employment_status=$5,updated_at=now()
         WHERE id=$1`,
        [anchorId, displayName, employeeNo, row.employment_type, row.employment_status]
      );
    } else {
      anchorId = (
        await client.query<{ id: string }>(
          `INSERT INTO people(display_name,employee_no,employment_type,employment_status)
           VALUES($1,$2,$3,$4) RETURNING id`,
          [displayName, employeeNo, row.employment_type, row.employment_status]
        )
      ).rows[0]!.id;
      rollback.push({ table: 'people', key: { id: anchorId }, before: null });
    }
    const roleBefore = (
      await client.query<Record<string, unknown>>(
        `SELECT * FROM person_roles WHERE person_id=$1 AND role='ANCHOR'`, [anchorId]
      )
    ).rows[0] ?? null;
    rollback.push({ table: 'person_roles', key: { person_id: anchorId, role: 'ANCHOR' }, before: roleBefore });
    await client.query(
      `INSERT INTO person_roles(person_id,role,enabled) VALUES($1,'ANCHOR',true)
       ON CONFLICT(person_id,role) DO UPDATE SET enabled=true,updated_at=now()`,
      [anchorId]
    );
    const profileBefore = (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM anchor_scheduling_profiles WHERE anchor_id=$1', [anchorId]
      )
    ).rows[0] ?? null;
    rollback.push({ table: 'anchor_scheduling_profiles', key: { anchor_id: anchorId }, before: profileBefore });
    await client.query(
      `INSERT INTO anchor_scheduling_profiles(
         anchor_id,eligible_for_auto_schedule,min_monthly_minutes,
         target_monthly_minutes,max_monthly_minutes
       ) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(anchor_id) DO UPDATE SET
         eligible_for_auto_schedule=EXCLUDED.eligible_for_auto_schedule,
         min_monthly_minutes=EXCLUDED.min_monthly_minutes,
         target_monthly_minutes=EXCLUDED.target_monthly_minutes,
         max_monthly_minutes=EXCLUDED.max_monthly_minutes,
         version=anchor_scheduling_profiles.version+1,updated_at=now()`,
      [
        anchorId, row.eligible_for_auto_schedule,
        row.min_monthly_minutes, row.target_monthly_minutes, row.max_monthly_minutes
      ]
    );
    return { type: 'PERSON', id: anchorId };
  }

  private async applyEligibility(
    client: PoolClient,
    row: NormalizedRow,
    rollback: RollbackOperation[]
  ) {
    const anchorId = await this.resolveAnchor(client, row);
    const roomId = await this.resolveRoom(client, row);
    const before = (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM anchor_room_eligibility WHERE anchor_id=$1 AND room_id=$2',
        [anchorId, roomId]
      )
    ).rows[0] ?? null;
    rollback.push({ table: 'anchor_room_eligibility', key: { anchor_id: anchorId, room_id: roomId }, before });
    await client.query(
      `INSERT INTO anchor_room_eligibility(anchor_id,room_id,eligible,priority,reason)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(anchor_id,room_id) DO UPDATE SET eligible=EXCLUDED.eligible,
         priority=EXCLUDED.priority,reason=EXCLUDED.reason,updated_at=now()`,
      [anchorId, roomId, row.eligible, row.priority, this.optionalString(row.reason)]
    );
    return { type: 'ANCHOR_ROOM_ELIGIBILITY', id: anchorId };
  }

  private async applyAvailability(
    client: PoolClient,
    row: NormalizedRow,
    rollback: RollbackOperation[]
  ) {
    const anchorId = await this.resolveAnchor(client, row);
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO anchor_availability_exceptions(
           anchor_id,starts_at,ends_at,availability_type,reason
         ) VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [anchorId, row.starts_at, row.ends_at, row.availability_type, this.optionalString(row.reason)]
      )
    ).rows[0]!.id;
    rollback.push({ table: 'anchor_availability_exceptions', key: { id }, before: null });
    return { type: 'ANCHOR_AVAILABILITY', id };
  }

  private async applyAbility(
    client: PoolClient,
    row: NormalizedRow,
    rollback: RollbackOperation[]
  ) {
    const anchorId = await this.resolveAnchor(client, row);
    const roomId = await this.resolveRoom(client, row);
    const sourceDocument = this.requiredString(row.source_document, 'source_document');
    const key = {
      anchor_id: anchorId,
      room_id: roomId,
      period_start: String(row.period_start),
      period_end: String(row.period_end),
      source_document: sourceDocument
    };
    const before = (
      await client.query<Record<string, unknown>>(
        `SELECT * FROM anchor_performance_scores WHERE anchor_id=$1 AND room_id=$2
           AND period_start=$3 AND period_end=$4 AND source_document=$5`,
        [anchorId, roomId, row.period_start, row.period_end, sourceDocument]
      )
    ).rows[0] ?? null;
    rollback.push({ table: 'anchor_performance_scores', key, before });
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO anchor_performance_scores(
           anchor_id,room_id,period_start,period_end,sample_hours,
           capability_score,confidence_grade,source_rank,source_document,
           adjusted_roi_index,adjusted_hourly_gmv_index,evidence_status,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12)
         ON CONFLICT(anchor_id,room_id,period_start,period_end,source_document)
         DO UPDATE SET sample_hours=EXCLUDED.sample_hours,
           capability_score=EXCLUDED.capability_score,
           confidence_grade=EXCLUDED.confidence_grade,
           adjusted_roi_index=EXCLUDED.adjusted_roi_index,
           adjusted_hourly_gmv_index=EXCLUDED.adjusted_hourly_gmv_index,
           evidence_status=EXCLUDED.evidence_status,metadata=EXCLUDED.metadata,
           updated_at=now() RETURNING id`,
        [
          anchorId, roomId, row.period_start, row.period_end,
          row.effective_hours, row.capability_score, row.confidence_grade,
          sourceDocument, this.nullableNumber(row.adjusted_roi_index),
          this.nullableNumber(row.adjusted_hourly_index),
          row.confidence_grade === 'A' ? 'FORMAL' : row.confidence_grade === 'B' ? 'PROVISIONAL' : 'OBSERVATION',
          JSON.stringify({ rawRoi: this.nullableNumber(row.raw_roi), rawHourlyGmv: this.nullableNumber(row.raw_hourly_gmv), abilityTier: row.ability_tier ?? null, remark: row.remark ?? null })
        ]
      )
    ).rows[0]!.id;
    return { type: 'ANCHOR_ABILITY', id };
  }

  private async applyCoverage(
    client: PoolClient,
    row: NormalizedRow,
    rollback: RollbackOperation[]
  ) {
    const roomId = await this.resolveRoom(client, row);
    const templateName = this.requiredString(row.template_name, 'template_name');
    const template = (
      await client.query<Record<string, unknown>>(
        `SELECT * FROM room_coverage_templates
         WHERE room_id=$1 AND name=$2 AND version=1 FOR UPDATE`,
        [roomId, templateName]
      )
    ).rows[0] ?? null;
    let templateId: string;
    if (template) {
      templateId = String(template.id);
      rollback.push({ table: 'room_coverage_templates', key: { id: templateId }, before: template });
      await client.query(`UPDATE room_coverage_templates SET status='DRAFT',updated_at=now() WHERE id=$1`, [templateId]);
    } else {
      templateId = (
        await client.query<{ id: string }>(
          `INSERT INTO room_coverage_templates(room_id,name,version,status)
           VALUES($1,$2,1,'DRAFT') RETURNING id`, [roomId, templateName]
        )
      ).rows[0]!.id;
      rollback.push({ table: 'room_coverage_templates', key: { id: templateId }, before: null });
    }
    const existingSlot = (
      await client.query<Record<string, unknown>>(
        `SELECT * FROM room_coverage_template_slots
         WHERE template_id=$1 AND day_of_week IS NOT DISTINCT FROM $2
           AND date_type=$3 AND start_minute=$4 AND end_minute=$5
         ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [templateId, row.day_of_week, row.date_type, row.start_minute, row.end_minute]
      )
    ).rows[0] ?? null;
    let slotId: string;
    if (existingSlot) {
      slotId = String(existingSlot.id);
      rollback.push({ table: 'room_coverage_template_slots', key: { id: slotId }, before: existingSlot });
      await client.query(
        `UPDATE room_coverage_template_slots SET block_minutes=$2,
           required_anchor_count=$3,priority=$4,enabled=$5,updated_at=now()
         WHERE id=$1`,
        [slotId, row.block_minutes, row.required_anchor_count, row.priority, row.enabled]
      );
    } else {
      slotId = (
        await client.query<{ id: string }>(
          `INSERT INTO room_coverage_template_slots(
             template_id,day_of_week,date_type,start_minute,end_minute,
             block_minutes,required_anchor_count,priority,enabled
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            templateId, row.day_of_week, row.date_type, row.start_minute,
            row.end_minute, row.block_minutes, row.required_anchor_count,
            row.priority, row.enabled
          ]
        )
      ).rows[0]!.id;
      rollback.push({ table: 'room_coverage_template_slots', key: { id: slotId }, before: null });
    }
    return { type: 'COVERAGE_TEMPLATE_SLOT', id: slotId };
  }

  private async resolveAnchor(client: PoolClient, row: NormalizedRow): Promise<string> {
    const employeeNo = this.optionalString(row.anchor_employee_no);
    const name = this.optionalString(row.anchor_display_name) ?? this.optionalString(row.display_name);
    const result = await client.query<{ id: string }>(
      `SELECT id FROM people WHERE archived_at IS NULL AND (
         ($1::text IS NOT NULL AND employee_no=$1)
         OR ($1::text IS NULL AND display_name=$2)
       ) ORDER BY employee_no NULLS LAST`,
      [employeeNo, name]
    );
    if (!result.rows.length) throw new BadRequestException(`找不到主播：${employeeNo ?? name ?? '未填写'}`);
    if (!employeeNo && result.rows.length > 1) throw new BadRequestException(`主播“${name}”存在同名人员，请使用工号`);
    return result.rows[0]!.id;
  }

  private async resolveRoom(client: PoolClient, row: NormalizedRow): Promise<string> {
    const name = this.requiredString(row.room_name, 'room_name');
    const room = (await client.query<{ id: string }>('SELECT id FROM rooms WHERE name=$1 AND enabled', [name])).rows[0];
    if (!room) throw new BadRequestException(`找不到启用的直播间：${name}`);
    return room.id;
  }

  private requiredString(value: unknown, field: string): string {
    const result = this.optionalString(value);
    if (!result) throw new BadRequestException(`${field}不能为空`);
    return result;
  }

  private optionalString(value: unknown): string | null {
    if (value == null) return null;
    const result = this.cellText(value).trim();
    return result || null;
  }

  private nullableNumber(value: unknown): number | null {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private async rollbackOperation(client: PoolClient, operation: RollbackOperation) {
    const whereEntries = Object.entries(operation.key);
    const where = whereEntries.map(([column], index) => `${column}=$${index + 1}`).join(' AND ');
    const keyValues = whereEntries.map(([, value]) => value);
    if (!operation.before) {
      await client.query(`DELETE FROM ${operation.table} WHERE ${where}`, keyValues);
      return;
    }
    const protectedColumns = new Set(['id', 'created_at']);
    const values = Object.entries(operation.before).filter(([column]) => !protectedColumns.has(column));
    const set = values.map(([column], index) => `${column}=$${keyValues.length + index + 1}`).join(',');
    await client.query(
      `UPDATE ${operation.table} SET ${set} WHERE ${where}`,
      [...keyValues, ...values.map(([, value]) => value)]
    );
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    action: string,
    resourceId: string,
    before: unknown,
    after: unknown
  ) {
    await client.query(
      `INSERT INTO operation_logs(actor_id,action,resource_type,resource_id,before_data,after_data)
       VALUES($1,$2,'SCHEDULE_IMPORT',$3,$4,$5)`,
      [actorId, action, resourceId, before ? JSON.stringify(before) : null, JSON.stringify(after)]
    );
  }
}
