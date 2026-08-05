import { ConflictException } from '@nestjs/common';
import { AppointmentStateMachineService } from './appointment-state-machine.service';

describe('AppointmentStateMachineService', () => {
  const service = new AppointmentStateMachineService();

  it.each([
    ['DRAFT', 'BOOKED'],
    ['BOOKED', 'IN_PROGRESS'],
    ['BOOKED', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETED'],
    ['IN_PROGRESS', 'EXCEPTION'],
    ['EXCEPTION', 'IN_PROGRESS'],
    ['EXCEPTION', 'CANCELLED'],
    ['EXCEPTION', 'COMPLETED'],
    ['RESCHEDULE_REQUIRED', 'BOOKED'],
    ['REASSIGN_REQUIRED', 'BOOKED']
  ] as const)('allows %s -> %s', (from, to) => {
    expect(service.canTransition(from, to)).toBe(true);
    expect(() => service.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['BOOKED', 'COMPLETED'],
    ['COMPLETED', 'IN_PROGRESS'],
    ['CANCELLED', 'BOOKED'],
    ['DRAFT', 'IN_PROGRESS']
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(service.canTransition(from, to)).toBe(false);
    expect(() => service.assertTransition(from, to)).toThrow(
      ConflictException
    );
  });
});
