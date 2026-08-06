import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GroupNotificationDeliveryService } from './group-notification-delivery.service';
import { ScheduleNotificationService } from './schedule-notification.service';

describe('ScheduleNotificationService', () => {
  const service = new ScheduleNotificationService(
    {} as DatabaseService,
    new ConfigService({ WEB_ORIGIN: 'http://localhost:8088' }),
    {} as GroupNotificationDeliveryService
  );

  it('enqueues one idempotent makeup-group message for a booked appointment', async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const query = jest.fn((sql: string, values?: unknown[]) => {
      calls.push([sql, values]);
      return Promise.resolve({ rows: [] });
    });

    await service.enqueueAppointmentBooked(
      { query } as unknown as PoolClient,
      { id: '00000000-0000-4000-8000-000000000001', data_version: 3 },
      'APPOINTMENT_BOOKED'
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(calls[0]?.[0]).toContain("'APPOINTMENT_BOOKED_GROUP'");
    expect(calls[0]?.[1]).toEqual([
      '00000000-0000-4000-8000-000000000001',
      'APPOINTMENT_BOOKED_GROUP:00000000-0000-4000-8000-000000000001:3',
      3
    ]);
  });

  it('does not notify the group for later appointment state changes', async () => {
    const query = jest.fn();

    await service.enqueueAppointmentBooked(
      { query } as unknown as PoolClient,
      { id: '00000000-0000-4000-8000-000000000001', data_version: 4 },
      'APPOINTMENT_COMPLETED'
    );

    expect(query).not.toHaveBeenCalled();
  });
});
