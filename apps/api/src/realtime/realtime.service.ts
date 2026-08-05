import { Injectable, MessageEvent } from '@nestjs/common';
import { CurrentUser } from '@jishi/contracts';
import { randomUUID } from 'node:crypto';
import {
  Observable,
  Subject,
  filter,
  interval,
  map,
  merge
} from 'rxjs';

interface RealtimeDomainEvent {
  id: string;
  type: string;
  occurredAt: string;
  recipientPersonIds: string[];
  roomIds: string[];
  data: Record<string, unknown>;
}

@Injectable()
export class RealtimeService {
  private readonly events = new Subject<RealtimeDomainEvent>();

  publish(
    type: string,
    data: Record<string, unknown>,
    recipientPersonIds: string[] = [],
    roomIds: string[] = []
  ): void {
    this.events.next({
      id: `${Date.now()}-${randomUUID()}`,
      type,
      occurredAt: new Date().toISOString(),
      recipientPersonIds: [...new Set(recipientPersonIds)],
      roomIds: [...new Set(roomIds)],
      data
    });
  }

  streamFor(user: CurrentUser): Observable<MessageEvent> {
    const elevated = user.roles.some((role) =>
      ['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER'].includes(role)
    );
    const domainEvents = this.events.pipe(
      filter(
        (event) =>
          elevated ||
          event.recipientPersonIds.includes(user.personId) ||
          event.roomIds.some((roomId) => user.roomIds.includes(roomId))
      ),
      map((event) => ({
        id: event.id,
        type: event.type,
        retry: 5_000,
        data: {
          occurredAt: event.occurredAt,
          ...event.data
        }
      }))
    );
    const heartbeat = interval(20_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { occurredAt: new Date().toISOString() }
      }))
    );
    return merge(domainEvents, heartbeat);
  }
}
