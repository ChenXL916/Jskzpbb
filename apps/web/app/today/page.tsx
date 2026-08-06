'use client';

import {
  CalendarClock,
  Check,
  Clock3,
  MapPin,
  Radio,
  Sparkles,
  UserRoundCheck
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { StatusBadge, statusLabel } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime, formatTime } from '@/lib/api';

interface Session {
  id: string;
  starts_at: string;
  ends_at: string;
  room_id: string;
  room_name: string;
  anchor_name: string;
  makeup_required: boolean;
  appointment_status?: string;
  appointment_id?: string;
  makeup_artist_name?: string;
  planned_start_at?: string;
  planned_end_at?: string;
}

interface TodayData {
  user: { displayName: string };
  nextLiveSession: Session | null;
  sessions: Session[];
  serverTime: string;
}

interface ArtistStatus {
  id: string;
  display_name: string;
  public_status:
    | 'AVAILABLE'
    | 'IN_PROGRESS'
    | 'BOOKED'
    | 'BUSY_SOON'
    | 'LEAVE'
    | 'BREAK'
    | 'UNAVAILABLE'
    | 'OFF_DUTY';
  current_task_ends_at?: string;
  next_busy_at?: string;
  status_until?: string;
}

interface Recommendation {
  makeupArtistId: string;
  makeupArtistName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  score: number;
}

interface RecommendationResponse {
  recommendations: Recommendation[];
}

export default function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [artists, setArtists] = useState<ArtistStatus[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedArtistId, setSelectedArtistId] = useState('');
  const [error, setError] = useState('');
  const [recommendationNotice, setRecommendationNotice] = useState('');
  const [booking, setBooking] = useState(false);

  const load = useCallback(async () => {
    const [today, artistStatuses] = await Promise.all([
      api<TodayData>('/me/today'),
      api<ArtistStatus[]>('/makeup-artists/availability')
    ]);
    setData(today);
    setArtists(artistStatuses);
    setSelectedSessionId((current) => current || today.nextLiveSession?.id || '');
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void load().catch((reason: Error) => setError(reason.message));
    }, 0);
    const timer = window.setInterval(() => {
      void api<ArtistStatus[]>('/makeup-artists/availability').then(setArtists);
    }, 30_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [load]);

  const session = useMemo(
    () =>
      data?.sessions.find((item) => item.id === selectedSessionId) ??
      data?.nextLiveSession ??
      null,
    [data, selectedSessionId]
  );

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!session || session.appointment_status || !session.makeup_required) {
        setRecommendations([]);
        setSelectedArtistId('');
        setRecommendationNotice('');
        return;
      }
      setRecommendationNotice('');
      void api<RecommendationResponse>(
        `/appointments/recommendations?liveSessionId=${session.id}`
      )
        .then((response) => {
          if (cancelled) return;
          setRecommendations(response.recommendations);
          setSelectedArtistId(response.recommendations[0]?.makeupArtistId ?? '');
          if (!response.recommendations.length) {
            setRecommendationNotice('该场次暂时没有满足班次和冲突规则的化妆师。');
          }
        })
        .catch((reason: Error) => {
          if (cancelled) return;
          setRecommendations([]);
          setSelectedArtistId('');
          setRecommendationNotice(reason.message);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session]);

  const quickBook = async () => {
    if (!session) return;
    setBooking(true);
    setError('');
    try {
      await api('/appointments/quick-book', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          liveSessionId: session.id,
          ...(selectedArtistId ? { makeupArtistId: selectedArtistId } : {})
        })
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约失败');
    } finally {
      setBooking(false);
    }
  };

  return (
    <AppShell>
      <main className="page">
        <p className="eyebrow">TODAY</p>
        <h1 className="title">
          {data ? `${data.user.displayName}，今天好` : '今日安排'}
        </h1>
        <p className="muted">
          主播只能为自己的正式直播班次预约。妆造固定在开播前 60 分钟开始，预计 40 分钟，并预留 20 分钟做开播准备。
        </p>

        <section className="artist-status-strip" aria-label="化妆师实时状态">
          <div className="artist-strip-title">
            <div>
              <p className="eyebrow">MAKEUP STATUS</p>
              <h2>化妆师现在是否可约</h2>
            </div>
            <span className="status success">
              <Radio size={13} /> 30 秒刷新
            </span>
          </div>
          <div className="artist-status-grid">
            {artists.map((artist) => (
              <article className="card artist-status-card" key={artist.id}>
                <div className="artist-avatar" aria-hidden>
                  {artist.display_name.slice(0, 1)}
                </div>
                <div>
                  <strong>{artist.display_name}</strong>
                  <StatusBadge status={artist.public_status} />
                  {artist.current_task_ends_at ? (
                    <small>预计 {formatTime(artist.current_task_ends_at)} 结束</small>
                  ) : artist.next_busy_at ? (
                    <small>下个任务 {formatTime(artist.next_busy_at)}</small>
                  ) : null}
                </div>
              </article>
            ))}
            {data && artists.length === 0 ? (
              <div className="card artist-status-card muted">
                暂无已启用且允许预约的化妆师。
              </div>
            ) : null}
          </div>
        </section>

        <div style={{ marginTop: '1.4rem' }}>
          {!data && !error ? <LoadingState /> : null}
          {error ? (
            <div className="card hero-card">
              <span className="status danger">需要处理</span>
              <p>{error}</p>
            </div>
          ) : null}
          {data && !session ? (
            <EmptyState
              title="暂时没有未来直播"
              description="正式排班发布后，可操作的主播直播班次会显示在这里。"
            />
          ) : null}
          {session ? (
            <div className="booking-workspace">
              <aside className="card session-picker">
                <p className="eyebrow">LIVE SESSIONS</p>
                <h2>选择主播场次</h2>
                <div className="session-list">
                  {data?.sessions.slice(0, 30).map((item) => (
                    <button
                      className={item.id === session.id ? 'active' : ''}
                      key={item.id}
                      onClick={() => setSelectedSessionId(item.id)}
                    >
                      <time>{formatTime(item.starts_at)}</time>
                      <span>
                        <strong>{item.anchor_name}</strong>
                        <small>
                          {formatDateTime(item.starts_at)} · {item.room_name}
                        </small>
                      </span>
                      <em>
                        {item.appointment_status
                          ? statusLabel(item.appointment_status)
                          : '未预约'}
                      </em>
                    </button>
                  ))}
                </div>
              </aside>

              <section className="card hero-card booking-detail">
                <div className="booking-summary">
                  <div>
                    <span
                      className={`status ${
                        session.appointment_status === 'COMPLETED'
                          ? 'success'
                          : session.appointment_status === 'IN_PROGRESS'
                            ? 'warning'
                            : ''
                      }`}
                    >
                      {session.appointment_status
                        ? statusLabel(session.appointment_status)
                        : session.makeup_required
                          ? '未预约'
                          : '无需妆造'}
                    </span>
                    <h2>{session.anchor_name}</h2>
                    <div className="grid" style={{ gap: '0.55rem' }}>
                      <span>
                        <MapPin
                          size={17}
                          style={{ display: 'inline', marginRight: 6 }}
                        />
                        {session.room_name}
                      </span>
                      <span>
                        <CalendarClock
                          size={17}
                          style={{ display: 'inline', marginRight: 6 }}
                        />
                        {formatDateTime(session.starts_at)}—
                        {formatTime(session.ends_at)}
                      </span>
                    </div>
                  </div>
                  <div className="live-time-callout">
                    <small>开播时间</small>
                    <strong>{formatTime(session.starts_at)}</strong>
                  </div>
                </div>

                {session.appointment_status ? (
                  <div className="selected-appointment">
                    <UserRoundCheck size={24} />
                    <div>
                      <p className="eyebrow">MAKEUP APPOINTMENT</p>
                      <h3>{session.makeup_artist_name ?? '化妆师待确认'}</h3>
                      {session.planned_start_at ? (
                        <p>
                          <Clock3 size={17} />
                          {formatTime(session.planned_start_at)}—
                          {formatTime(session.planned_end_at!)}
                        </p>
                      ) : null}
                    </div>
                    <div className="status success">
                      <Check size={14} /> 已锁定
                    </div>
                  </div>
                ) : session.makeup_required ? (
                  <div className="recommendation-panel">
                    <div>
                      <p className="eyebrow">SELECT MAKEUP ARTIST</p>
                      <h3>选择化妆师并一键预约</h3>
                      <p className="muted">
                        预约只绑定当前主播场次；直播间和开播时间由正式排班带出，超过开播前 60 分钟的预约节点后不能临时预约。
                      </p>
                    </div>
                    <div className="recommendation-list">
                      {recommendations.map((item, index) => {
                        const status = artists.find(
                          (artist) => artist.id === item.makeupArtistId
                        );
                        return (
                          <button
                            className={
                              item.makeupArtistId === selectedArtistId
                                ? 'active'
                                : ''
                            }
                            key={item.makeupArtistId}
                            onClick={() =>
                              setSelectedArtistId(item.makeupArtistId)
                            }
                          >
                            <span className="artist-avatar" aria-hidden>
                              {item.makeupArtistName.slice(0, 1)}
                            </span>
                            <span>
                              <strong>
                                {item.makeupArtistName}
                                {index === 0 ? <em>推荐</em> : null}
                              </strong>
                              <small>
                                {formatTime(item.startsAt)}–
                                {formatTime(item.endsAt)} · {item.reason}
                              </small>
                            </span>
                            <span className="status success">
                              {status
                                ? statusLabel(status.public_status)
                                : '时段可约'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {recommendationNotice ? (
                      <p className="booking-notice">{recommendationNotice}</p>
                    ) : null}
                    <button
                      className="button booking-button"
                      disabled={booking || !selectedArtistId}
                      onClick={() => void quickBook()}
                    >
                      <Sparkles size={18} />
                      {booking ? '正在锁定并通知化妆师…' : '确认预约并发送消息'}
                    </button>
                  </div>
                ) : (
                  <p className="muted">本场直播不需要创建妆造预约。</p>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}
