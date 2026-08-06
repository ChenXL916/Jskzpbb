import { ConflictException, Injectable } from '@nestjs/common';
import { AppointmentStatus } from '@jishi/contracts';

const allowedTransitions: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  DRAFT: ['BOOKED'],
  BOOKED: [
    'IN_PROGRESS',
    'CANCELLED',
    'RESCHEDULE_REQUIRED',
    'REASSIGN_REQUIRED'
  ],
  IN_PROGRESS: ['COMPLETED', 'EXCEPTION'],
  EXCEPTION: ['IN_PROGRESS', 'CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  RESCHEDULE_REQUIRED: ['BOOKED', 'CANCELLED'],
  REASSIGN_REQUIRED: ['BOOKED', 'CANCELLED'],
  RESCHEDULED: [],
  PENDING_CONFIRMATION: ['BOOKED', 'CANCELLED'],
  CONFLICT: ['BOOKED', 'CANCELLED']
};

@Injectable()
export class AppointmentStateMachineService {
  canTransition(
    from: AppointmentStatus,
    to: AppointmentStatus
  ): boolean {
    return allowedTransitions[from]?.includes(to) ?? false;
  }

  assertTransition(
    from: AppointmentStatus,
    to: AppointmentStatus
  ): void {
    if (!this.canTransition(from, to)) {
      throw new ConflictException(
        `预约状态不能从“${this.label(from)}”变更为“${this.label(to)}”`
      );
    }
  }

  label(status: AppointmentStatus): string {
    const labels: Record<AppointmentStatus, string> = {
      DRAFT: '待确认',
      BOOKED: '已预约',
      IN_PROGRESS: '妆造中',
      COMPLETED: '已完成',
      CANCELLED: '已取消',
      RESCHEDULE_REQUIRED: '待改期',
      REASSIGN_REQUIRED: '待重新分配',
      EXCEPTION: '异常',
      RESCHEDULED: '已改期',
      PENDING_CONFIRMATION: '待确认',
      CONFLICT: '冲突'
    };
    return labels[status];
  }
}
