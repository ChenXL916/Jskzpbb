'use client';

import { CalendarClock, RotateCcw, Trash2, X } from 'lucide-react';
import { CurrentUser } from '@jishi/contracts';
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react';
import { AppShell } from '@/components/app-shell';
import {
  AlertBanner,
  PersonAvatar,
  StatusBadge,
  TimeRange,
  statusLabel
} from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface Appointment {
  id: string;
  appointment_no: string;
  status: string;
  room_name: string;
  makeup_artist_name: string;
  planned_start_at: string;
  planned_end_at: string;
  actual_start_at?: string | null;
  actual_end_at?: string | null;
  live_starts_at?: string | null;
  subject_type?: 'ANCHOR' | 'TALENT' | 'DIRECTOR';
}

const groupOrder = ['BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
function toShanghaiInput(value: string) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(value))
    .replace(' ', 'T');
}

export default function AppointmentsPage() {
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
  const [rescheduleTarget, setRescheduleTarget] =
    useState<Appointment | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);

  const load = useCallback(async () => {
    try {
      const [appointments, currentUser] = await Promise.all([
        api<Appointment[]>('/me/appointments'),
        api<CurrentUser>('/auth/me')
      ]);
      setRows(appointments);
      setUser(currentUser);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约记录加载失败');
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    window.addEventListener('jishi:data-updated', load);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('jishi:data-updated', load);
    };
  }, [load]);

  const grouped = useMemo(() => {
    const result = new Map<string, Appointment[]>();
    for (const row of rows ?? []) {
      const key = groupOrder.includes(row.status) ? row.status : row.status;
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return [...result.entries()].sort(
      ([left], [right]) =>
        (groupOrder.indexOf(left) < 0 ? 99 : groupOrder.indexOf(left)) -
        (groupOrder.indexOf(right) < 0 ? 99 : groupOrder.indexOf(right))
    );
  }, [rows]);
  const canChange = Boolean(
    user?.permissions?.some((permission) =>
      ['appointment.update', 'appointment.cancel'].includes(permission)
    )
  );

  const cancelAppointment = async () => {
    if (!cancelTarget) return;
    setSaving(true);
    setError('');
    try {
      await api(`/appointments/${cancelTarget.id}/cancel`, { method: 'PATCH' });
      setMessage('预约已取消，原时间已释放，相关人员通知已进入消息队列');
      setCancelTarget(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '取消预约失败');
    } finally {
      setSaving(false);
    }
  };

  const rescheduleAppointment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rescheduleTarget) return;
    setSaving(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const localValue = String(data.get('plannedStartAt') ?? '');
    try {
      await api(`/appointments/${rescheduleTarget.id}/reschedule`, {
        method: 'PATCH',
        body: JSON.stringify({
          plannedStartAt: new Date(`${localValue}:00+08:00`).toISOString()
        })
      });
      setMessage('预约时间已调整，班次和冲突校验通过');
      setRescheduleTarget(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约改期失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">MY APPOINTMENTS</p>
            <h1 className="title">我的妆造预约</h1>
            <p className="muted">
              预约按执行状态分组；改期和取消都会重新校验并通知相关人员。
            </p>
          </div>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}
        {!rows ? <LoadingState label="正在读取预约记录…" /> : null}
        {rows?.length === 0 ? (
          <EmptyState
            title="暂无预约"
            description="完成妆造预约后会显示在这里。"
          />
        ) : null}

        <div className="appointment-groups">
          {grouped.map(([status, appointments]) => (
            <section key={status}>
              <div className="section-label">
                <strong>{statusLabel(status)}</strong>
                <span>{appointments.length}</span>
              </div>
              <div className="appointment-card-list">
                {appointments.map((row) => (
                  <article className="card appointment-record" key={row.id}>
                    <div className="appointment-record-person">
                      <PersonAvatar name={row.makeup_artist_name} />
                      <span>
                        <strong>{row.makeup_artist_name}</strong>
                        <small>{row.room_name}</small>
                      </span>
                    </div>
                    <div>
                      <small>妆造时间</small>
                      <TimeRange
                        startsAt={row.planned_start_at}
                        endsAt={row.planned_end_at}
                      />
                    </div>
                    <div>
                      <small>开播时间</small>
                      <strong>
                        {row.live_starts_at
                          ? formatDateTime(row.live_starts_at)
                          : '非直播妆造'}
                      </strong>
                    </div>
                    <StatusBadge status={row.status} />
                    {row.status === 'BOOKED' && canChange ? (
                      <div className="appointment-record-actions">
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() => setRescheduleTarget(row)}
                        >
                          <RotateCcw size={15} aria-hidden />
                          改期
                        </button>
                        <button
                          className="button danger compact"
                          type="button"
                          onClick={() => setCancelTarget(row)}
                        >
                          <Trash2 size={15} aria-hidden />
                          取消
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        {rescheduleTarget ? (
          <div className="dialog-backdrop" role="presentation">
            <form
              className="dialog-card"
              role="dialog"
              aria-modal
              onSubmit={(event) => void rescheduleAppointment(event)}
            >
              <header>
                <div>
                  <p className="eyebrow">RESCHEDULE</p>
                  <h2>调整妆造时间</h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭"
                  onClick={() => setRescheduleTarget(null)}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <AlertBanner
                tone="info"
                title="提交时会重新检查化妆师班次、休息、冲突和开播缓冲"
              />
              <label className="field">
                新的开始时间
                <input
                  name="plannedStartAt"
                  type="datetime-local"
                  required
                  defaultValue={toShanghaiInput(
                    rescheduleTarget.planned_start_at
                  )}
                />
              </label>
              <footer>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setRescheduleTarget(null)}
                >
                  取消
                </button>
                <button className="button" type="submit" disabled={saving}>
                  <CalendarClock size={16} aria-hidden />
                  {saving ? '校验中…' : '确认改期'}
                </button>
              </footer>
            </form>
          </div>
        ) : null}

        {cancelTarget ? (
          <div className="dialog-backdrop" role="presentation">
            <section className="dialog-card" role="dialog" aria-modal>
              <header>
                <div>
                  <p className="eyebrow">CONFIRM CANCEL</p>
                  <h2>确认取消预约？</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => setCancelTarget(null)}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <p className="muted">
                取消后将释放 {cancelTarget.makeup_artist_name} 的预约时间，并通知相关人员。
              </p>
              <footer>
                <button
                  className="button secondary"
                  onClick={() => setCancelTarget(null)}
                >
                  返回
                </button>
                <button
                  className="button danger"
                  disabled={saving}
                  onClick={() => void cancelAppointment()}
                >
                  {saving ? '取消中…' : '确认取消预约'}
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
