import { CurrentUser } from '@jishi/contracts';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PoolClient } from 'pg';
import { AutoSchedulingService } from './auto-scheduling.service';

describe('AutoSchedulingService monthly automation', () => {
  it('替换草案月工时排除目标月全部草案房间中的未来旧AUTO_PLAN', async () => {
    const queryTexts: string[] = [];
    const dbQuery = jest.fn(async (sql: string) => {
      queryTexts.push(sql);
      if (
        sql.includes('FROM monthly_schedule_plans WHERE id=$1') &&
        !sql.includes('WITH target AS')
      ) {
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              schedule_month: '2026-09-01',
              status: 'DRAFT',
              rules_snapshot: {},
              generation_summary: {
                existingSchedulePolicy: 'REPLACE_AUTO_PLAN'
              },
              validation_summary: null,
              version: 1,
              created_at: new Date(),
              updated_at: new Date(),
              published_at: null
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = new AutoSchedulingService(
      { query: dbQuery } as unknown as DatabaseService,
      { publish: jest.fn() } as unknown as RealtimeService
    );

    await service.get('11111111-1111-4111-8111-111111111111');

    const hoursSql = queryTexts.find((sql) => sql.includes('WITH target AS'));
    expect(hoursSql).toBeDefined();
    expect(hoursSql).toContain('plan_rooms AS');
    expect(hoursSql).toContain('FROM monthly_schedule_slots');
    expect(hoursSql).toContain("generation_summary->>'existingSchedulePolicy'");
    expect(hoursSql).toContain("generation_summary->>'generationStrategy'");
    expect(hoursSql).toContain(
      "target.existing_schedule_policy='REPLACE_AUTO_PLAN'"
    );
    expect(hoursSql).toContain("session.source_type='AUTO_PLAN'");
    expect(hoursSql).toContain(
      "session.source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')"
    );
    expect(hoursSql).toContain('session.starts_at>now()');
    expect(hoursSql).toContain('session.starts_at>=target.month_start');
    expect(hoursSql).toContain('session.starts_at<target.month_end');
    expect(hoursSql).toContain('plan_rooms.room_id=session.room_id');
  });

  it('在同月已有有效草案时通过事务锁幂等跳过', async () => {
    const queryTexts: string[] = [];
    const clientQuery = jest.fn(async (sql: string) => {
      queryTexts.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("permission.code='schedule.auto_generate'")) {
        return { rows: [{ allowed: 1 }] };
      }
      return {
        rows: [{ id: '11111111-1111-4111-8111-111111111111' }]
      };
    });
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      transaction: (work: (client: { query: typeof clientQuery }) => unknown) =>
        work({ query: clientQuery })
    } as unknown as DatabaseService;
    const realtimePublish = jest.fn();
    const realtime = { publish: realtimePublish } as unknown as RealtimeService;
    const service = new AutoSchedulingService(db, realtime);
    const user: CurrentUser = {
      id: '22222222-2222-4222-8222-222222222222',
      personId: '33333333-3333-4333-8333-333333333333',
      displayName: '系统排班操作人',
      roles: ['DEVELOPER'],
      roomIds: []
    };

    await expect(
      service.generateScheduledDraft(user, {
        month: '2026-09',
        roomIds: ['44444444-4444-4444-8444-444444444444'],
        coverageStartHour: 0,
        coverageEndHour: 24,
        blockHours: 4
      })
    ).resolves.toEqual({
      created: false,
      planId: '11111111-1111-4111-8111-111111111111'
    });
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(queryTexts[0]).toContain('pg_advisory_xact_lock');
    expect(queryTexts[1]).toContain("permission.code='schedule.auto_generate'");
    expect(queryTexts[2]).toContain(
      "status IN ('DRAFT','VALIDATED','PUBLISHED')"
    );
    expect(realtimePublish).not.toHaveBeenCalled();
  });

  it('发布替换策略只软取消AUTO_PLAN并归档旧发布计划', async () => {
    const queryTexts: string[] = [];
    let call = 0;
    const clientQuery = jest.fn(async (sql: string) => {
      queryTexts.push(sql);
      call += 1;
      if (call === 1) return { rows: [] };
      if (call === 2) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (call === 3) {
        return { rows: [{ id: '66666666-6666-4666-8666-666666666666' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const db = {} as DatabaseService;
    const service = new AutoSchedulingService(
      db,
      { publish: jest.fn() } as unknown as RealtimeService
    );
    const internals = service as unknown as {
      replaceAutoPlanSessions(
        client: PoolClient,
        user: CurrentUser,
        plan: Record<string, unknown>,
        candidates: Array<Record<string, unknown>>
      ): Promise<{ replacedCount: number; archivedPlanIds: string[] }>;
    };
    const user: CurrentUser = {
      id: '22222222-2222-4222-8222-222222222222',
      personId: '33333333-3333-4333-8333-333333333333',
      displayName: '系统排班操作人',
      roles: ['DEVELOPER'],
      roomIds: []
    };
    const result = await internals.replaceAutoPlanSessions(
      { query: clientQuery } as unknown as PoolClient,
      user,
      { id: '77777777-7777-4777-8777-777777777777' },
      [
        {
          id: '66666666-6666-4666-8666-666666666666',
          room_id: '88888888-8888-4888-8888-888888888888',
          anchor_id: '99999999-9999-4999-8999-999999999999',
          starts_at: new Date('2026-09-01T00:00:00.000Z'),
          ends_at: new Date('2026-09-01T03:00:00.000Z'),
          source_fingerprint: 'AUTO:test'
        }
      ]
    );
    expect(result).toEqual({
      replacedCount: 1,
      archivedPlanIds: ['55555555-5555-4555-8555-555555555555']
    });
    const cancellationSql = queryTexts.find((sql) =>
      sql.includes('UPDATE live_sessions')
    );
    expect(cancellationSql).toContain("source_type='AUTO_PLAN'");
    expect(cancellationSql).toContain("status='CANCELLED'");
    expect(queryTexts.join('\n')).not.toContain('DELETE FROM live_sessions');
  });

  it('替换候选来自草案全部房间和目标月，而不是只看新分配重叠', async () => {
    const roomIds = [
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999'
    ];
    const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const clientQuery = jest.fn(async (sql: string, params?: unknown[]) => {
      queryCalls.push(params ? { sql, params } : { sql });
      if (sql.includes('FROM monthly_schedule_slots')) {
        return { rows: roomIds.map((room_id) => ({ room_id })), rowCount: 2 };
      }
      return {
        rows: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            room_id: roomIds[1],
            anchor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            starts_at: new Date('2026-09-05T00:00:00.000Z'),
            ends_at: new Date('2026-09-05T03:00:00.000Z'),
            source_fingerprint: 'AUTO:old'
          }
        ],
        rowCount: 1
      };
    });
    const service = new AutoSchedulingService(
      {} as DatabaseService,
      { publish: jest.fn() } as unknown as RealtimeService
    );
    const internals = service as unknown as {
      replacementCandidates(
        client: PoolClient,
        plan: Record<string, unknown>
      ): Promise<Array<Record<string, unknown>>>;
    };

    const result = await internals.replacementCandidates(
      { query: clientQuery } as unknown as PoolClient,
      {
        id: '77777777-7777-4777-8777-777777777777',
        schedule_month: '2026-09-01',
        generation_summary: {
          existingSchedulePolicy: 'REPLACE_AUTO_PLAN'
        }
      }
    );

    expect(result).toHaveLength(1);
    expect(queryCalls[0]!.sql).toContain('FROM monthly_schedule_slots');
    expect(queryCalls[0]!.sql).toContain("status<>'CANCELLED'");
    expect(queryCalls[1]!.sql).toContain("session.source_type='AUTO_PLAN'");
    expect(queryCalls[1]!.sql).toContain('session.room_id=ANY($1::uuid[])');
    expect(queryCalls[1]!.sql).not.toContain('monthly_schedule_assignments');
    expect(queryCalls[1]!.params).toEqual([
      roomIds,
      '2026-08-31T16:00:00.000Z',
      '2026-09-30T16:00:00.000Z'
    ]);
  });

  it('空草案产生硬错误且不能发布任何正式场次', async () => {
    const queryTexts: string[] = [];
    const queryParams: unknown[][] = [];
    const plan = {
      id: '77777777-7777-4777-8777-777777777777',
      schedule_month: '2026-09-01',
      status: 'DRAFT',
      rules_snapshot: {},
      generation_summary: {
        existingSchedulePolicy: 'PRESERVE_EXISTING'
      },
      validation_summary: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      published_at: null
    };
    const clientQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
      queryTexts.push(sql);
      queryParams.push(params);
      if (sql.includes('FROM monthly_schedule_plans WHERE id=$1 FOR UPDATE')) {
        return { rows: [plan], rowCount: 1 };
      }
      if (
        sql.includes('SELECT DISTINCT anchor_id') &&
        sql.includes('FROM monthly_schedule_assignments')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('SELECT DISTINCT room_id') &&
        sql.includes('FROM monthly_schedule_slots')
      ) {
        return {
          rows: [
            { room_id: '88888888-8888-4888-8888-888888888888' }
          ],
          rowCount: 1
        };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes('FROM monthly_schedule_assignments assignment') &&
        sql.includes('JOIN people person')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('SELECT slot.id') &&
        sql.includes('FROM monthly_schedule_slots slot')
      ) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const db = {
      transaction: (work: (client: { query: typeof clientQuery }) => unknown) =>
        work({ query: clientQuery })
    } as unknown as DatabaseService;
    const service = new AutoSchedulingService(
      db,
      { publish: jest.fn() } as unknown as RealtimeService
    );
    const user: CurrentUser = {
      id: '22222222-2222-4222-8222-222222222222',
      personId: '33333333-3333-4333-8333-333333333333',
      displayName: '系统排班操作人',
      roles: ['DEVELOPER'],
      roomIds: []
    };

    await expect(service.publish(user, plan.id)).rejects.toThrow(
      '草案仍有 1 个硬约束问题，不能发布'
    );
    expect(JSON.stringify(queryParams)).toContain('EMPTY_PLAN');
    expect(queryTexts.join('\n')).not.toContain('INSERT INTO live_sessions');
  });

  it('发布校验按连续直播段合并，相邻3+3小时为6小时而有间隔的两段分别计算', () => {
    const service = new AutoSchedulingService(
      {} as DatabaseService,
      { publish: jest.fn() } as unknown as RealtimeService
    );
    const internals = service as unknown as {
      continuousScheduleGroups(
        ranges: Array<{
          startsAt: Date;
          endsAt: Date;
          assignmentId?: string;
        }>
      ): Array<{
        startsAt: Date;
        endsAt: Date;
        assignmentIds: string[];
      }>;
    };

    const groups = internals.continuousScheduleGroups([
      {
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-01T03:00:00.000Z'),
        assignmentId: 'first'
      },
      {
        startsAt: new Date('2026-08-01T03:00:00.000Z'),
        endsAt: new Date('2026-08-01T06:00:00.000Z'),
        assignmentId: 'second'
      },
      {
        startsAt: new Date('2026-08-01T09:00:00.000Z'),
        endsAt: new Date('2026-08-01T12:00:00.000Z'),
        assignmentId: 'third'
      }
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-01T06:00:00.000Z'),
      assignmentIds: ['first', 'second']
    });
    expect(groups[1]).toMatchObject({ assignmentIds: ['third'] });
  });

  it('casts the undo actor id as uuid when restoring assignment locks', async () => {
    const queryTexts: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queryTexts.push(sql);
        return { rows: [], rowCount: 0 };
      })
    } as unknown as PoolClient;
    const service = new AutoSchedulingService(
      {} as DatabaseService,
      { publish: jest.fn() } as unknown as RealtimeService
    );
    const internals = service as unknown as {
      restorePlanState(
        dbClient: PoolClient,
        planId: string,
        snapshot: { slots: unknown[]; assignments: unknown[] },
        actorId: string
      ): Promise<void>;
    };

    await internals.restorePlanState(
      client,
      '77777777-7777-4777-8777-777777777777',
      { slots: [], assignments: [] },
      '33333333-3333-4333-8333-333333333333'
    );

    const assignmentSql = queryTexts.find((sql) =>
      sql.includes('UPDATE monthly_schedule_assignments target')
    );
    expect(assignmentSql).toContain('$3::uuid');
  });
});
