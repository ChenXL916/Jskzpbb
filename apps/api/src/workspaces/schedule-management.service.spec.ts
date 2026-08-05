import { BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ScheduleManagementService } from './schedule-management.service';

describe('ScheduleManagementService', () => {
  it('rejects reversed ranges and supports cross-day shift dates', () => {
    const service = new ScheduleManagementService(
      {} as DatabaseService,
      {} as RealtimeService
    );
    const internals = service as unknown as {
      assertRange(start: string, end: string): void;
      nextDate(date: string): string;
    };

    expect(() =>
      internals.assertRange(
        '2026-07-31T10:00:00+08:00',
        '2026-07-31T09:00:00+08:00'
      )
    ).toThrow(BadRequestException);
    expect(internals.nextDate('2026-07-31')).toBe('2026-08-01');
  });

  it('allows two non-contiguous three-hour sessions on the same day', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          starts_at: new Date('2026-08-01T00:00:00.000Z'),
          ends_at: new Date('2026-08-01T03:00:00.000Z')
        }
      ]
    });
    const service = new ScheduleManagementService(
      {} as DatabaseService,
      {} as RealtimeService
    );
    const internals = service as unknown as {
      assertContinuousLiveLimit(
        client: { query: typeof query },
        dto: { anchorId: string; startsAt: string; endsAt: string },
        excludeId?: string
      ): Promise<void>;
    };

    await expect(
      internals.assertContinuousLiveLimit(
        { query },
        {
          anchorId: '00000000-0000-4000-8000-000000000002',
          startsAt: '2026-08-01T14:00:00+08:00',
          endsAt: '2026-08-01T17:00:00+08:00'
        }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects adjacent three-hour sessions that form six continuous hours', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          starts_at: new Date('2026-08-01T00:00:00.000Z'),
          ends_at: new Date('2026-08-01T03:00:00.000Z')
        }
      ]
    });
    const service = new ScheduleManagementService(
      {} as DatabaseService,
      {} as RealtimeService
    );
    const internals = service as unknown as {
      assertContinuousLiveLimit(
        client: { query: typeof query },
        dto: { anchorId: string; startsAt: string; endsAt: string },
        excludeId?: string
      ): Promise<void>;
    };

    await expect(
      internals.assertContinuousLiveLimit(
        { query },
        {
          anchorId: '00000000-0000-4000-8000-000000000002',
          startsAt: '2026-08-01T11:00:00+08:00',
          endsAt: '2026-08-01T14:00:00+08:00'
        }
      )
    ).rejects.toThrow('该主播单次连续直播不能超过5小时');
  });

  it('rejects a live session when the anchor has no staff shift for the day', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const service = new ScheduleManagementService(
      {} as DatabaseService,
      {} as RealtimeService
    );
    const internals = service as unknown as {
      assertAnchorAvailability(
        client: { query: typeof query },
        dto: { anchorId: string; startsAt: string; endsAt: string }
      ): Promise<void>;
    };

    await expect(
      internals.assertAnchorAvailability(
        { query },
        {
          anchorId: '00000000-0000-4000-8000-000000000002',
          startsAt: '2026-08-01T10:00:00+08:00',
          endsAt: '2026-08-01T13:00:00+08:00'
        }
      )
    ).rejects.toThrow('该主播当天没有可用于直播的人员班次');
  });

  it('rejects a live session when the field control shift does not cover it', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          is_rest: false,
          is_leave: false,
          is_bookable: true,
          parse_status: 'SUCCESS',
          starts_at: new Date('2026-08-01T01:30:00.000Z'),
          ends_at: new Date('2026-08-01T04:30:00.000Z')
        }
      ]
    });
    const service = new ScheduleManagementService(
      {} as DatabaseService,
      {} as RealtimeService
    );
    const internals = service as unknown as {
      assertFieldControlAvailability(
        client: { query: typeof query },
        dto: {
          fieldControlId: string;
          anchorId: string;
          startsAt: string;
          endsAt: string;
        }
      ): Promise<void>;
    };

    await expect(
      internals.assertFieldControlAvailability(
        { query },
        {
          fieldControlId: '00000000-0000-4000-8000-000000000003',
          anchorId: '00000000-0000-4000-8000-000000000002',
          startsAt: '2026-08-01T10:00:00+08:00',
          endsAt: '2026-08-01T13:00:00+08:00'
        }
      )
    ).rejects.toThrow('该场控的有效班次未完整覆盖直播时段');
  });

  it('prevents creating an overlapping room schedule inside the transaction', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM rooms')) return { rows: [{ id: 'room-1' }] };
      if (sql.includes('JOIN person_roles')) {
        return { rows: [{ id: 'anchor-1' }] };
      }
      if (sql.includes('FROM live_sessions')) {
        return {
          rows: [
            {
              id: 'existing-session',
              room_conflict: true,
              anchor_conflict: false
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const db = {
      transaction: (work: (client: { query: typeof query }) => Promise<unknown>) =>
        work({ query })
    } as unknown as DatabaseService;
    const realtime = {
      publish: jest.fn()
    } as unknown as RealtimeService;
    const service = new ScheduleManagementService(db, realtime);

    await expect(
      service.createLiveSession(
        {
          id: 'user-1',
          personId: 'manager-1',
          displayName: '排班主管',
          roles: ['LIVE_SUPERVISOR'],
          roomIds: []
        },
        {
          roomId: '00000000-0000-4000-8000-000000000001',
          anchorId: '00000000-0000-4000-8000-000000000002',
          startsAt: '2026-07-31T10:00:00+08:00',
          endsAt: '2026-07-31T12:00:00+08:00',
          scheduleType: 'LIVE',
          makeupRequired: true
        }
      )
    ).rejects.toThrow(ConflictException);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO live_sessions'))
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "source_type IN ('LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')"
        )
      )
    ).toBe(true);
    expect((realtime.publish as jest.Mock).mock.calls).toHaveLength(0);
  });
});
