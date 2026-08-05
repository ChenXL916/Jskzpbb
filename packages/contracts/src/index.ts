export type PersonRole =
  | 'ANCHOR'
  | 'TALENT'
  | 'DIRECTOR'
  | 'MAKEUP_ARTIST'
  | 'FIELD_CONTROL'
  | 'LIVE_SUPERVISOR'
  | 'ADMIN'
  | 'DEVELOPER';

export type AppointmentStatus =
  | 'DRAFT'
  | 'BOOKED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RESCHEDULE_REQUIRED'
  | 'REASSIGN_REQUIRED'
  | 'EXCEPTION'
  | 'RESCHEDULED'
  | 'PENDING_CONFIRMATION'
  | 'CONFLICT';

export type ParseStatus = 'SUCCESS' | 'NEEDS_CONFIRMATION' | 'FAILED';

export interface CurrentUser {
  id: string;
  personId: string;
  displayName: string;
  avatarUrl?: string;
  roles: PersonRole[];
  permissions?: string[];
  roomIds: string[];
}

export interface LiveSessionSummary {
  id: string;
  roomId: string;
  roomName: string;
  anchorId: string;
  anchorName: string;
  startsAt: string;
  endsAt: string;
  makeupRequired: boolean;
  appointmentStatus?: AppointmentStatus;
}

export interface MakeupRecommendation {
  makeupArtistId: string;
  makeupArtistName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  score: number;
}

export interface RequesterAvailabilitySlot {
  startsAt: string;
  endsAt: string;
  estimated: true;
}

export interface RequesterMakeupArtistAvailability {
  makeupArtistId: string;
  makeupArtistName: string;
  publicStatus:
    | 'AVAILABLE'
    | 'BUSY_SOON'
    | 'BOOKED'
    | 'IN_PROGRESS'
    | 'OFF_DUTY'
    | 'BREAK'
    | 'LEAVE'
    | 'UNAVAILABLE';
  nextAvailableAt?: string;
  statusUntil?: string;
  slots: RequesterAvailabilitySlot[];
}
