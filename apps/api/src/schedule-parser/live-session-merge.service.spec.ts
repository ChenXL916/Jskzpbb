import { LiveSessionMergeService } from './live-session-merge.service';

describe('LiveSessionMergeService', () => {
  it('merges adjacent hourly slots for the same anchor and room', () => {
    const service = new LiveSessionMergeService();
    const sessions = service.merge([
      {
        id: '1',
        roomId: 'room',
        anchorId: 'anchor',
        startsAt: '2026-07-16T02:00:00.000Z',
        endsAt: '2026-07-16T03:00:00.000Z',
        scheduleType: 'LIVE',
        makeupRequired: true
      },
      {
        id: '2',
        roomId: 'room',
        anchorId: 'anchor',
        startsAt: '2026-07-16T03:00:00.000Z',
        endsAt: '2026-07-16T04:00:00.000Z',
        scheduleType: 'LIVE',
        makeupRequired: true
      },
      {
        id: '3',
        roomId: 'room',
        anchorId: 'anchor',
        startsAt: '2026-07-16T05:00:00.000Z',
        endsAt: '2026-07-16T06:00:00.000Z',
        scheduleType: 'LIVE',
        makeupRequired: true
      }
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      startsAt: '2026-07-16T02:00:00.000Z',
      endsAt: '2026-07-16T04:00:00.000Z',
      sourceSlotIds: ['1', '2']
    });
  });
});
