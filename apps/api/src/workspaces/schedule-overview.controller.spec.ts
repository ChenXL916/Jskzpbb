import { DatabaseService } from '../database/database.service';
import { FeishuSyncService } from '../feishu/feishu-sync.service';
import { ScheduleOverviewController } from './schedule-overview.controller';

const syncService = {
  runAll: jest.fn()
} as unknown as FeishuSyncService;

describe('ScheduleOverviewController monthly schedule', () => {
  it('builds anchor day cells from live sessions instead of staff shift labels', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            person_id: 'anchor-1',
            display_name: '陈莹',
            role: 'ANCHOR',
            employment_status: '正式',
            schedule_date: '2026-07-01',
            raw_shift_value: '自由班',
            starts_at: null,
            ends_at: null,
            parse_status: 'NEEDS_CONFIRMATION',
            is_rest: false
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'session-1',
            person_id: 'anchor-1',
            display_name: '陈莹',
            employment_status: '正式',
            schedule_date: '2026-07-01',
            room_id: 'room-1',
            room_name: '柏瑞美-散粉',
            starts_at: new Date('2026-07-01T02:00:00.000Z'),
            ends_at: new Date('2026-07-01T05:00:00.000Z'),
            schedule_type: 'LIVE'
          },
          {
            id: 'session-2',
            person_id: 'anchor-1',
            display_name: '陈莹',
            employment_status: '正式',
            schedule_date: '2026-07-01',
            room_id: 'room-2',
            room_name: '柏瑞美-妆前乳',
            starts_at: new Date('2026-07-01T08:00:00.000Z'),
            ends_at: new Date('2026-07-01T10:00:00.000Z'),
            schedule_type: 'LIVE'
          }
        ]
      });
    const controller = new ScheduleOverviewController(
      { query } as unknown as DatabaseService,
      syncService
    );

    const result = await controller.monthly({
      month: '2026-07',
      role: 'ANCHOR'
    });

    expect(result.sourceMode).toBe('ANCHOR_LIVE_SCHEDULE');
    expect(result.people).toHaveLength(1);
    expect(result.people[0]?.days['1']).toMatchObject({
      raw: '',
      source: 'LIVE_SCHEDULE',
      parseStatus: 'SUCCESS',
      isRest: false
    });
    expect(result.people[0]?.days['1']?.liveSessions).toHaveLength(2);
    const queryCalls = query.mock.calls as unknown as Array<[string]>;
    expect(queryCalls[0]?.[0]).toContain(
      "s.source_type='FEISHU'"
    );
    expect(queryCalls[1]?.[0]).toContain(
      "ls.source_type='FEISHU'"
    );
    expect(
      result.people[0]?.days['1']?.liveSessions?.map((session) => [
        session.roomName,
        session.id
      ])
    ).toEqual([
      ['柏瑞美-散粉', 'session-1'],
      ['柏瑞美-妆前乳', 'session-2']
    ]);
  });
});

describe('ScheduleOverviewController live board', () => {
  it('returns local program sessions without Feishu hourly mirror rows', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'room-1', name: '柏瑞美-散粉' }]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'session-1',
            room_id: 'room-1',
            anchor_name: '陈莹',
            starts_at: new Date('2026-07-30T01:00:00.000Z'),
            ends_at: new Date('2026-07-30T04:00:00.000Z')
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });
    const controller = new ScheduleOverviewController(
      { query } as unknown as DatabaseService,
      syncService
    );

    const result = await controller.liveBoard(
      {
        roles: ['ADMIN'],
        roomIds: []
      } as never,
      { date: '2026-07-30' }
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.slots).toEqual([]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "ls.source_type='FEISHU'"
      ),
      ['2026-07-30', null, null]
    );
  });
});

describe('ScheduleOverviewController access boundary', () => {
  it('exposes the aggregate schedule only to scheduling management roles', () => {
    expect(
      Reflect.getMetadata('requiredRoles', ScheduleOverviewController)
    ).toEqual(['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER']);
  });
});
