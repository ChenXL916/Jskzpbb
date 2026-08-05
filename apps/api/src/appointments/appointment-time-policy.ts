export interface AppointmentWindow {
  startsAt: Date;
  endsAt: Date;
  remainingBufferMinutes: number;
}

export function anchorAppointmentWindow(
  liveStartsAt: Date,
  durationMinutes: number,
  leadMinutes: number
): AppointmentWindow {
  if (!Number.isFinite(liveStartsAt.getTime())) {
    throw new Error('Live start time is invalid');
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new Error('Makeup duration must be a positive integer');
  }
  if (!Number.isInteger(leadMinutes) || leadMinutes <= 0) {
    throw new Error('Anchor booking lead time must be a positive integer');
  }
  if (durationMinutes > leadMinutes) {
    throw new Error('Makeup duration cannot exceed the anchor lead time');
  }

  const startsAt = new Date(
    liveStartsAt.getTime() - leadMinutes * 60_000
  );
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
    remainingBufferMinutes: leadMinutes - durationMinutes
  };
}

export function isGeneralRequesterDurationAllowed(
  durationMinutes: number
): boolean {
  return Number.isInteger(durationMinutes) &&
    durationMinutes >= 30 &&
    durationMinutes <= 40;
}
