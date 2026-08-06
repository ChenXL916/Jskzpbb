'use client';

import { CalendarDays, Clock3, Radio, Sparkles, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge, TimeRange } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';

interface PersonalShift {
  id: string;
  role: 'ANCHOR' | 'MAKEUP_ARTIST' | 'FIELD_CONTROL';
  schedule_date: string;
  raw_shift_value: string;
  starts_at?: string | null;
  ends_at?: string | null;
  is_rest: boolean;
  is_leave: boolean;
  parse_status: string;
  notes?: string | null;
}

interface PersonalLiveSession {
  id: string;
  starts_at: string;
  ends_at: string;
  room_name: string;
  anchor_name: string;
  assignment_role: 'ANCHOR' | 'FIELD_CONTROL';
}

interface PersonalAppointment {
  id: string;
  appointment_no: string;
  status: string;
  planned_start_at: string;
  planned_end_at: string;
  location?: string;
  subject_name: string;
  makeup_artist_name: string;
}

interface PersonalSchedule {
  month: string;
  person: { id: string; displayName: string };
  roles: string[];
  shifts: PersonalShift[];
  liveSessions: PersonalLiveSession[];
  appointments: PersonalAppointment[];
}

interface ScheduleItem {
  id: string;
  day: string;
  startsAt: string | null;
  endsAt: string | null;
  type: 'SHIFT' | 'LIVE' | 'APPOINTMENT';
  title: string;
  detail: string;
  status: string;
  note: string | null;
}

const roleLabels: Record<string, string> = {
  ANCHOR: '主播',
  MAKEUP_ARTIST: '化妆师',
  FIELD_CONTROL: '场控'
};

function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit'
  })
    .format(new Date())
    .slice(0, 7);
}

function localDay(value: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function dayHeading(day: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(`${day}T00:00:00+08:00`));
}

export default function MySchedulePage() {
  const [month, setMonth] = useState(currentMonth);
  const [schedule, setSchedule] = useState<PersonalSchedule | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setSchedule(null);
    try {
      setSchedule(
        await api<PersonalSchedule>(
          `/me/schedule?month=${encodeURIComponent(month)}`
        )
      );
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '本人排班加载失败');
    }
  }, [month]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    window.addEventListener('jishi:data-updated', load);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('jishi:data-updated', load);
    };
  }, [load]);

  const grouped = useMemo(() => {
    if (!schedule) return [];
    const items: ScheduleItem[] = [
      ...schedule.shifts.map((shift) => ({
        id: `shift-${shift.id}`,
        day: shift.schedule_date,
        startsAt: shift.starts_at ?? null,
        endsAt: shift.ends_at ?? null,
        type: 'SHIFT' as const,
        title: shift.is_leave
          ? '请假'
          : shift.is_rest
            ? '休息'
            : shift.raw_shift_value || `${roleLabels[shift.role]}班次`,
        detail: `${roleLabels[shift.role]} · 本人班次`,
        status: shift.is_leave ? 'LEAVE' : shift.is_rest ? 'REST' : 'PUBLISHED',
        note: shift.notes ?? null
      })),
      ...schedule.liveSessions.map((session) => ({
        id: `live-${session.id}`,
        day: localDay(session.starts_at),
        startsAt: session.starts_at,
        endsAt: session.ends_at,
        type: 'LIVE' as const,
        title:
          session.assignment_role === 'ANCHOR'
            ? session.room_name
            : `${session.room_name} · ${session.anchor_name}`,
        detail:
          session.assignment_role === 'ANCHOR'
            ? '本人直播'
            : '本人负责场控',
        status: 'PUBLISHED',
        note: null
      })),
      ...schedule.appointments.map((appointment) => ({
        id: `appointment-${appointment.id}`,
        day: localDay(appointment.planned_start_at),
        startsAt: appointment.planned_start_at,
        endsAt: appointment.planned_end_at,
        type: 'APPOINTMENT' as const,
        title: schedule.roles.includes('MAKEUP_ARTIST')
          ? `妆造对象：${appointment.subject_name}`
          : `化妆师：${appointment.makeup_artist_name}`,
        detail: `${appointment.location || '妆造地点待确认'} · ${appointment.appointment_no}`,
        status: appointment.status,
        note: null
      }))
    ];
    const byDay = new Map<string, ScheduleItem[]>();
    for (const item of items) {
      const rows = byDay.get(item.day) ?? [];
      rows.push(item);
      byDay.set(item.day, rows);
    }
    return [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, rows]) => ({
        day,
        rows: rows.sort((left, right) =>
          String(left.startsAt ?? '').localeCompare(String(right.startsAt ?? ''))
        )
      }));
  }, [schedule]);

  return (
    <AppShell>
      <main className="page operations-page personal-schedule-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">MY SCHEDULE</p>
            <h1 className="title">我的排班</h1>
            <p className="muted">
              这里只显示与你本人直接关联的班次、直播和妆造任务，不提供排班编辑功能。
            </p>
          </div>
          <label className="field compact-field personal-month-filter">
            月份
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </label>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {!schedule && !error ? <LoadingState label="正在读取本人排班…" /> : null}

        {schedule ? (
          <>
            <section className="personal-schedule-summary">
              <article className="metric-card">
                <UserRound size={20} aria-hidden />
                <small>当前人员</small>
                <strong>{schedule.person.displayName}</strong>
                <span>{schedule.roles.map((role) => roleLabels[role]).filter(Boolean).join(' / ') || '本人'}</span>
              </article>
              <article className="metric-card">
                <CalendarDays size={20} aria-hidden />
                <small>人员班次</small>
                <strong>{schedule.shifts.length}</strong>
                <span>仅本人记录</span>
              </article>
              <article className="metric-card">
                <Radio size={20} aria-hidden />
                <small>关联直播</small>
                <strong>{schedule.liveSessions.length}</strong>
                <span>本人主播或场控任务</span>
              </article>
              <article className="metric-card">
                <Sparkles size={20} aria-hidden />
                <small>妆造安排</small>
                <strong>{schedule.appointments.length}</strong>
                <span>本人预约或执行任务</span>
              </article>
            </section>

            {grouped.length ? (
              <section className="personal-schedule-days">
                {grouped.map((group) => (
                  <article className="card personal-schedule-day" key={group.day}>
                    <header>
                      <CalendarDays size={19} aria-hidden />
                      <div>
                        <strong>{dayHeading(group.day)}</strong>
                        <small>{group.rows.length} 项本人安排</small>
                      </div>
                    </header>
                    <div className="personal-schedule-list">
                      {group.rows.map((item) => (
                        <div className={`personal-schedule-item ${item.type.toLowerCase()}`} key={item.id}>
                          <span className="personal-schedule-type" aria-hidden>
                            {item.type === 'LIVE' ? <Radio size={17} /> : item.type === 'APPOINTMENT' ? <Sparkles size={17} /> : <Clock3 size={17} />}
                          </span>
                          <div>
                            <strong>{item.title}</strong>
                            <span>{item.detail}</span>
                            {item.note ? <small>{item.note}</small> : null}
                          </div>
                          <div className="personal-schedule-time">
                            {item.startsAt && item.endsAt ? (
                              <TimeRange startsAt={item.startsAt} endsAt={item.endsAt} />
                            ) : (
                              <span>全天</span>
                            )}
                            {item.status ? <StatusBadge status={item.status} /> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            ) : (
              <EmptyState
                title="本月暂无本人排班"
                description="这里不会展示其他人员的排班；如排班遗漏，请联系主管或管理员处理。"
              />
            )}
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
