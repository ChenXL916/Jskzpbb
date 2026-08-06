'use client';

import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Sparkles,
  X
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { CurrentUser, RequesterMakeupArtistAvailability } from '@jishi/contracts';
import { AppShell } from '@/components/app-shell';
import {
  AlertBanner,
  PersonAvatar,
  StatusBadge,
  TimeRange
} from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface ServiceType {
  code: string;
  name: string;
  defaultMinutes: number;
}

interface RequesterAppointment {
  id: string;
  appointment_no: string;
  status: string;
  subject_type: 'TALENT' | 'DIRECTOR';
  planned_start_at: string;
  planned_end_at: string;
  location: string;
  makeup_artist_name: string;
}

interface RequesterDashboard {
  date: string;
  generatedAt: string;
  serviceType: ServiceType;
  services: ServiceType[];
  artists: RequesterMakeupArtistAvailability[];
  appointments: RequesterAppointment[];
}

interface SelectedSlot {
  artist: RequesterMakeupArtistAvailability;
  startsAt: string;
  endsAt: string;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function time(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export default function RequesterPage() {
  const [date, setDate] = useState(shanghaiDate);
  const [serviceType, setServiceType] = useState('GENERAL_MAKEUP');
  const [dashboard, setDashboard] = useState<RequesterDashboard | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [selected, setSelected] = useState<SelectedSlot | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [currentUser, result] = await Promise.all([
        api<CurrentUser>('/auth/me'),
        api<RequesterDashboard>(
          `/appointments/requester-dashboard?date=${encodeURIComponent(
            date
          )}&serviceTypeCode=${encodeURIComponent(serviceType)}`
        )
      ]);
      setUser(currentUser);
      setDashboard(result);
      setError('');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '化妆师可预约时间加载失败'
      );
    }
  }, [date, serviceType]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    window.addEventListener('jishi:data-updated', load);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('jishi:data-updated', load);
    };
  }, [load]);

  const canBook = Boolean(
    user?.roles.some((role) => role === 'TALENT' || role === 'DIRECTOR')
  );
  const upcoming = useMemo(
    () => {
      const referenceTime = dashboard
        ? new Date(dashboard.generatedAt).getTime()
        : 0;
      return (dashboard?.appointments ?? []).filter(
        (row) =>
          !['CANCELLED', 'COMPLETED'].includes(row.status) &&
          new Date(row.planned_end_at).getTime() >= referenceTime
      );
    },
    [dashboard]
  );

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    setMessage('');
    const data = new FormData(event.currentTarget);
    try {
      await api('/appointments/requester-book', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          makeupArtistId: selected.artist.makeupArtistId,
          plannedStartAt: selected.startsAt,
          serviceTypeCode: dashboard?.serviceType.code,
          location: String(data.get('location') ?? '').trim() || undefined,
          note: String(data.get('note') ?? '').trim() || undefined
        })
      });
      setMessage(
        `预约成功：${selected.artist.makeupArtistName}，预计 ${time(
          selected.startsAt
        )}—${time(selected.endsAt)}`
      );
      setSelected(null);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : '预约失败，请选择系统刷新后的可预约时间'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <main className="page operations-page requester-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">MAKEUP BOOKING</p>
            <h1 className="title">预约化妆师</h1>
            <p className="muted">
              达人和编导无需绑定直播场次。这里只展示化妆师的空闲、已预约或妆造中状态，以及预计可约时间。
            </p>
          </div>
          <span className="source-tag">时间均为预计，以任务状态更新为准</span>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}

        <section className="card requester-filters">
          <label className="field">
            预约日期
            <input
              type="date"
              min={shanghaiDate()}
              value={date}
              onChange={(event) => {
                setDashboard(null);
                setDate(event.target.value);
              }}
            />
          </label>
          <label className="field">
            妆造类型
            <select
              value={serviceType}
              onChange={(event) => {
                setDashboard(null);
                setServiceType(event.target.value);
              }}
            >
              {(dashboard?.services ?? []).map((service) => (
                <option key={service.code} value={service.code}>
                  {service.name} · 预计 {service.defaultMinutes} 分钟
                </option>
              ))}
              {!dashboard ? (
                <option value="GENERAL_MAKEUP">日常妆造 · 预计 40 分钟</option>
              ) : null}
            </select>
          </label>
          <div className="requester-duration">
            <Clock3 size={18} aria-hidden />
            <span>
              <small>本次预计时长</small>
              <strong>
                {dashboard?.serviceType.defaultMinutes ?? '—'} 分钟
              </strong>
            </span>
          </div>
        </section>

        {!dashboard ? <LoadingState label="正在计算可预约时间…" /> : null}

        {dashboard ? (
          <section className="requester-availability">
            <div className="section-label">
              <strong>化妆师可预约时间</strong>
              <span>{dashboard.artists.length} 人</span>
            </div>
            {dashboard.artists.length ? (
              <div className="requester-artist-grid">
                {dashboard.artists.map((artist) => (
                  <article className="card requester-artist-card" key={artist.makeupArtistId}>
                    <header>
                      <PersonAvatar name={artist.makeupArtistName} />
                      <div>
                        <strong>{artist.makeupArtistName}</strong>
                        <StatusBadge
                          status={artist.publicStatus}
                        />
                        {artist.statusUntil &&
                        ['BOOKED', 'IN_PROGRESS'].includes(
                          artist.publicStatus
                        ) ? (
                          <small>
                            预计 {time(artist.statusUntil)} 结束
                          </small>
                        ) : null}
                      </div>
                    </header>
                    <div className="requester-next-slot">
                      <small>下一预计可约</small>
                      <strong>
                        {artist.nextAvailableAt
                          ? formatDateTime(artist.nextAvailableAt)
                          : '所选日期暂无可约时间'}
                      </strong>
                    </div>
                    <div className="requester-slot-list">
                      {artist.slots.slice(0, 6).map((slot) => (
                        <button
                          className="requester-slot"
                          type="button"
                          key={slot.startsAt}
                          disabled={!canBook}
                          onClick={() =>
                            setSelected({
                              artist,
                              startsAt: slot.startsAt,
                              endsAt: slot.endsAt
                            })
                          }
                        >
                          <CalendarClock size={15} aria-hidden />
                          {time(slot.startsAt)}—{time(slot.endsAt)}
                          <small>预计</small>
                        </button>
                      ))}
                      {!artist.slots.length ? (
                        <span className="muted compact-copy">
                          可能未排班、休息、请假或已约满
                        </span>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="尚无可预约化妆师"
                description="请先由排班人员为化妆师安排有效班次。"
              />
            )}
          </section>
        ) : null}

        {dashboard ? (
          <section className="requester-own-appointments" id="appointments">
            <div className="section-label">
              <strong>我的预约</strong>
              <span>{upcoming.length} 个待执行</span>
            </div>
            {dashboard.appointments.length ? (
              <div className="appointment-card-list">
                {dashboard.appointments.map((row) => (
                  <article className="card requester-appointment" key={row.id}>
                    <PersonAvatar name={row.makeup_artist_name} />
                    <div>
                      <small>化妆师</small>
                      <strong>{row.makeup_artist_name}</strong>
                    </div>
                    <div>
                      <small>预计妆造时间</small>
                      <TimeRange
                        startsAt={row.planned_start_at}
                        endsAt={row.planned_end_at}
                      />
                    </div>
                    <div>
                      <small>地点</small>
                      <strong>{row.location}</strong>
                    </div>
                    <StatusBadge
                      status={row.status}
                    />
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="还没有预约"
                description="选择上方预计可约时间即可发起预约。"
              />
            )}
          </section>
        ) : null}

        {!canBook && dashboard ? (
          <AlertBanner
            tone="info"
            title="当前为开发者预览"
          >
            预约按钮仅对已绑定“达人”或“编导”角色的账号开放。
          </AlertBanner>
        ) : null}

        {selected ? (
          <div className="dialog-backdrop" role="presentation">
            <form
              className="dialog-card requester-book-dialog"
              role="dialog"
              aria-modal
              onSubmit={(event) => void book(event)}
            >
              <header>
                <div>
                  <p className="eyebrow">CONFIRM BOOKING</p>
                  <h2>确认妆造预约</h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭"
                  onClick={() => setSelected(null)}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <div className="requester-confirm-summary">
                <PersonAvatar name={selected.artist.makeupArtistName} />
                <div>
                  <strong>{selected.artist.makeupArtistName}</strong>
                  <span>
                    预计 {formatDateTime(selected.startsAt)}—{time(selected.endsAt)}
                  </span>
                </div>
                <CheckCircle2 size={24} aria-hidden />
              </div>
              <AlertBanner
                tone="info"
                title="提交时会再次检查班次、休息、请假和预约冲突"
              />
              <label className="field">
                妆造地点
                <input name="location" defaultValue="妆造间" maxLength={255} />
              </label>
              <label className="field">
                妆造说明（选填）
                <textarea
                  name="note"
                  rows={3}
                  maxLength={2000}
                  placeholder="例如：拍摄妆、发型要求或需要携带的参考"
                />
              </label>
              <footer>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setSelected(null)}
                >
                  返回
                </button>
                <button className="button" type="submit" disabled={saving}>
                  <Sparkles size={16} aria-hidden />
                  {saving ? '正在锁定时间…' : '确认预约'}
                </button>
              </footer>
            </form>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
