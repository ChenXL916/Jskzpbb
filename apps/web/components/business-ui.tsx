import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert
} from 'lucide-react';
import { ReactNode } from 'react';
import { formatTime } from '@/lib/api';

type BadgeTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export const statusPresentation: Record<
  string,
  { label: string; tone: BadgeTone }
> = {
  UNBOOKED: { label: '未预约', tone: 'neutral' },
  DRAFT: { label: '待确认', tone: 'neutral' },
  PUBLISHED: { label: '已发布', tone: 'success' },
  CHANGED: { label: '有变更', tone: 'warning' },
  BOOKED: { label: '已预约', tone: 'info' },
  IN_PROGRESS: { label: '妆造中', tone: 'warning' },
  COMPLETED: { label: '已完成', tone: 'success' },
  CANCELLED: { label: '已取消', tone: 'neutral' },
  RESCHEDULE_REQUIRED: { label: '待改期', tone: 'danger' },
  REASSIGN_REQUIRED: { label: '待重新分配', tone: 'danger' },
  EXCEPTION: { label: '异常', tone: 'danger' },
  AVAILABLE: { label: '空闲 · 可预约', tone: 'success' },
  BUSY: { label: '忙碌中', tone: 'warning' },
  BUSY_SOON: { label: '即将有任务', tone: 'warning' },
  REST: { label: '休息中', tone: 'neutral' },
  OFFLINE: { label: '已下班', tone: 'neutral' },
  OFF_DUTY: { label: '未上班', tone: 'neutral' },
  BREAK: { label: '休息中', tone: 'neutral' },
  LEAVE: { label: '请假', tone: 'danger' },
  UNAVAILABLE: { label: '临时不可用', tone: 'neutral' },
  REMINDER: { label: '提醒', tone: 'info' },
  WARNING: { label: '警告', tone: 'warning' },
  URGENT: { label: '紧急', tone: 'danger' },
  SUCCEEDED: { label: '成功', tone: 'success' },
  PARTIAL: { label: '部分成功', tone: 'warning' },
  FAILED: { label: '失败', tone: 'danger' },
  RUNNING: { label: '进行中', tone: 'info' },
  PENDING: { label: '等待中', tone: 'neutral' },
  UPLOADED: { label: '待修正', tone: 'warning' },
  READY: { label: '预检通过', tone: 'info' },
  IMPORTING: { label: '导入中', tone: 'info' },
  ROLLED_BACK: { label: '已回滚', tone: 'neutral' },
  PREFERRED: { label: '优先', tone: 'success' },
  AVOID: { label: '尽量避开', tone: 'warning' },
  WAITING_CONFIGURATION: { label: '等待配置', tone: 'warning' },
  DEAD: { label: '停止重试', tone: 'danger' }
};

export function statusLabel(status: string, fallback?: string) {
  return statusPresentation[status]?.label ?? fallback ?? status;
}

export function StatusBadge({
  status,
  label
}: {
  status: string;
  label?: string;
}) {
  const presentation = statusPresentation[status] ?? {
    label: label ?? status,
    tone: 'neutral' as const
  };
  return (
    <span className={`status-badge ${presentation.tone}`}>
      {label ?? presentation.label}
    </span>
  );
}

export function PersonAvatar({
  name,
  src,
  size = 'md'
}: {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img className={`person-avatar ${size}`} src={src} alt={`${name}头像`} />
    );
  }
  return (
    <span className={`person-avatar ${size}`} aria-label={name}>
      {name.slice(0, 1)}
    </span>
  );
}

export function TimeRange({
  startsAt,
  endsAt
}: {
  startsAt: string | Date;
  endsAt: string | Date;
}) {
  return (
    <time className="time-range">
      {formatTime(startsAt)}—{formatTime(endsAt)}
    </time>
  );
}

export function AlertBanner({
  tone = 'info',
  title,
  children,
  action
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon =
    tone === 'danger'
      ? AlertCircle
      : tone === 'warning'
        ? TriangleAlert
        : tone === 'success'
          ? CheckCircle2
          : Info;
  return (
    <section className={`alert-banner ${tone}`} role="status">
      <Icon size={19} aria-hidden />
      <div>
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="alert-banner-action">{action}</div> : null}
    </section>
  );
}
