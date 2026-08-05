import {
  anchorAppointmentWindow,
  isGeneralRequesterDurationAllowed
} from './appointment-time-policy';

describe('appointment time policy', () => {
  it('starts anchor makeup exactly one hour before live and reserves 20 minutes', () => {
    const window = anchorAppointmentWindow(
      new Date('2026-08-05T08:00:00+08:00'),
      40,
      60
    );

    expect(window.startsAt.toISOString()).toBe('2026-08-04T23:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2026-08-04T23:40:00.000Z');
    expect(window.remainingBufferMinutes).toBe(20);
  });

  it('rejects a service that would finish after the live start', () => {
    expect(() =>
      anchorAppointmentWindow(
        new Date('2026-08-05T08:00:00+08:00'),
        90,
        60
      )
    ).toThrow('Makeup duration cannot exceed the anchor lead time');
  });

  it('only allows 30 to 40 minute services for talent and director booking', () => {
    expect(isGeneralRequesterDurationAllowed(30)).toBe(true);
    expect(isGeneralRequesterDurationAllowed(40)).toBe(true);
    expect(isGeneralRequesterDurationAllowed(29)).toBe(false);
    expect(isGeneralRequesterDurationAllowed(45)).toBe(false);
  });
});
