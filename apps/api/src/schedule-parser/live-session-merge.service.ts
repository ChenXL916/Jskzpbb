import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface MergeableSlot {
  id: string;
  roomId: string;
  anchorId: string;
  startsAt: string;
  endsAt: string;
  scheduleType: string;
  makeupRequired: boolean;
}

export interface MergedLiveSession {
  roomId: string;
  anchorId: string;
  startsAt: string;
  endsAt: string;
  scheduleType: string;
  makeupRequired: boolean;
  sourceSlotIds: string[];
  fingerprint: string;
}

@Injectable()
export class LiveSessionMergeService {
  merge(slots: MergeableSlot[]): MergedLiveSession[] {
    const sorted = [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const result: MergedLiveSession[] = [];
    for (const slot of sorted) {
      const previous = result.at(-1);
      if (
        previous &&
        previous.roomId === slot.roomId &&
        previous.anchorId === slot.anchorId &&
        previous.scheduleType === slot.scheduleType &&
        previous.endsAt === slot.startsAt
      ) {
        previous.endsAt = slot.endsAt;
        previous.makeupRequired ||= slot.makeupRequired;
        previous.sourceSlotIds.push(slot.id);
        previous.fingerprint = this.fingerprint(previous);
        continue;
      }
      const session: MergedLiveSession = {
        roomId: slot.roomId,
        anchorId: slot.anchorId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        scheduleType: slot.scheduleType,
        makeupRequired: slot.makeupRequired,
        sourceSlotIds: [slot.id],
        fingerprint: ''
      };
      session.fingerprint = this.fingerprint(session);
      result.push(session);
    }
    return result;
  }

  private fingerprint(session: Omit<MergedLiveSession, 'fingerprint'>): string {
    return createHash('sha256')
      .update(
        [
          session.roomId,
          session.anchorId,
          session.startsAt,
          session.endsAt,
          session.scheduleType
        ].join('|')
      )
      .digest('hex');
  }
}
