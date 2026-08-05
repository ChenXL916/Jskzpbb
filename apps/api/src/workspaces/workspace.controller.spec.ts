import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MeController } from './workspace.controller';

describe('MeController personal schedule', () => {
  it('loads only the authenticated person and their operational roles', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'shift-1', role: 'ANCHOR' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'live-1', assignment_role: 'ANCHOR' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'appointment-1', status: 'BOOKED' }] });
    const controller = new MeController({ query } as unknown as DatabaseService);

    const result = await controller.schedule(
      {
        personId: '11111111-1111-4111-8111-111111111111',
        displayName: '测试主播',
        roles: ['ANCHOR'],
        roomIds: []
      } as never,
      '2026-08'
    );

    expect(result.roles).toEqual(['ANCHOR']);
    expect(result.shifts).toHaveLength(1);
    expect(result.liveSessions).toHaveLength(1);
    expect(result.appointments).toHaveLength(1);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    for (const [, parameters] of calls) {
      expect(parameters).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '2026-08-01',
        '2026-09-01',
        ['ANCHOR']
      ]);
    }
    expect(calls[1]?.[0]).toContain('ls.anchor_id=$1');
    expect(calls[2]?.[0]).toContain('a.subject_person_id=$1');
  });

  it('rejects an invalid month before querying the database', async () => {
    const query = jest.fn();
    const controller = new MeController({ query } as unknown as DatabaseService);

    await expect(
      controller.schedule(
        {
          personId: '11111111-1111-4111-8111-111111111111',
          displayName: '测试主播',
          roles: ['ANCHOR'],
          roomIds: []
        } as never,
        '2026-13'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});
