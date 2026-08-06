import { CurrentUser } from '@jishi/contracts';
import { DatabaseService } from '../database/database.service';
import { ScheduleImportService } from './schedule-import.service';

interface ImportServiceInternals {
  parseCsv(content: string): Array<Record<string, string>>;
  validate(
    type: 'ANCHORS' | 'ELIGIBILITY' | 'AVAILABILITY' | 'ABILITY' | 'COVERAGE',
    row: Record<string, string>,
    rowNumber: number
  ): {
    normalized: Record<string, string | number | boolean | null>;
    errors: string[];
  };
}

describe('ScheduleImportService', () => {
  const service = new ScheduleImportService({} as DatabaseService);
  const internals = service as unknown as ImportServiceInternals;

  it('解析带逗号和双引号的 CSV 内容', () => {
    const rows = internals.parseCsv(
      'display_name,employee_no,remark\r\n"陈莹",A001,"直播间A,优先"\r\n'
    );

    expect(rows).toEqual([
      { display_name: '陈莹', employee_no: 'A001', remark: '直播间A,优先' }
    ]);
  });

  it('把全职主播工时小时数标准化为分钟', () => {
    const result = internals.validate('ANCHORS', {
      display_name: '陈莹',
      employee_no: 'A001',
      employment_type: 'FULL_TIME',
      employment_status: 'ACTIVE',
      eligible_for_auto_schedule: 'true',
      min_monthly_hours: '104',
      target_monthly_hours: '117',
      max_monthly_hours: '130'
    }, 2);

    expect(result.errors).toEqual([]);
    expect(result.normalized).toMatchObject({
      min_monthly_minutes: 6240,
      target_monthly_minutes: 7020,
      max_monthly_minutes: 7800,
      eligible_for_auto_schedule: true
    });
  });

  it('校验并标准化上海时区可用性时间', () => {
    const result = internals.validate('AVAILABILITY', {
      anchor_employee_no: 'A001',
      anchor_display_name: '陈莹',
      starts_at: '2026-08-10 09:30:00',
      ends_at: '2026-08-10 18:30:00',
      availability_type: 'UNAVAILABLE'
    }, 2);

    expect(result.errors).toEqual([]);
    expect(result.normalized.starts_at).toBe('2026-08-10T01:30:00.000Z');
    expect(result.normalized.ends_at).toBe('2026-08-10T10:30:00.000Z');
  });

  it('拒绝结束时间不晚于开始时间和非法能力置信度', () => {
    const availability = internals.validate('AVAILABILITY', {
      anchor_display_name: '陈莹',
      starts_at: '2026-08-10 10:00',
      ends_at: '2026-08-10 09:00',
      availability_type: 'UNAVAILABLE'
    }, 2);
    const ability = internals.validate('ABILITY', {
      anchor_display_name: '陈莹', room_name: '柏瑞美-散粉',
      period_start: '2026-07-01', period_end: '2026-07-31',
      effective_hours: '30', capability_score: '100',
      confidence_grade: 'D', source_document: '诊断报告'
    }, 2);

    expect(availability.errors).toContain('ends_at必须晚于starts_at');
    expect(ability.errors).toContain('confidence_grade只能是A/B/C');
  });

  it('uses the transaction-local job id when persisting validated rows', async () => {
    const jobId = '9f33780e-44eb-46fa-a683-9a80f12eb54a';
    const personId = 'c62bdc14-626b-4f51-9f54-c7fdbbe8caac';
    const client = {
      query: jest.fn(async (sql: string, _values?: unknown[]) => {
        void _values;
        if (sql.includes('INSERT INTO schedule_import_jobs')) {
          return { rows: [{ id: jobId }] };
        }
        return { rows: [] };
      })
    };
    const db = {
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: jobId, status: 'READY' }] })
        .mockResolvedValueOnce({ rows: [] })
    } as unknown as DatabaseService;
    const importService = new ScheduleImportService(db);
    const user: CurrentUser = {
      id: 'b14cd4c8-678c-4672-bf4e-9105314bf073',
      personId,
      displayName: 'Developer',
      roles: ['DEVELOPER'],
      roomIds: []
    };

    await importService.upload(user, 'ANCHORS', {
      originalname: 'anchors.csv',
      mimetype: 'text/csv',
      size: 150,
      buffer: Buffer.from(
        'display_name,employment_type,employment_status\nTest Anchor,FULL_TIME,ACTIVE\n'
      )
    });

    const itemInsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO schedule_import_job_items')
    );
    expect(itemInsert?.[1]?.[0]).toBe(jobId);
  });
});
