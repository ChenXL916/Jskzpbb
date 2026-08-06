'use client';

import {
  CalendarPlus,
  RefreshCw,
  UsersRound,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import {
  AlertBanner,
  PersonAvatar,
  StatusBadge,
  TimeRange
} from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatTime } from '@/lib/api';

interface Room {
  id: string;
  name: string;
}

interface BoardRow {
  live_session_id: string;
  appointment_id?: string;
  live_starts_at: string;
  live_ends_at: string;
  anchor_name: string;
  makeup_artist_name?: string;
  planned_start_at?: string;
  planned_end_at?: string;
  appointment_status?: string;
  risk: string;
  domain_risk_type?: string;
  risk_severity?: 'INFO' | 'WARNING' | 'URGENT';
}

interface Recommendation {
  makeupArtistId: string;
  makeupArtistName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  score: number;
}

interface ActionPlan {
  mode: 'BOOK' | 'REASSIGN';
  row: BoardRow;
  recommendations: Recommendation[];
}

const riskLabels: Record<string, string> = {
  NO_MAKEUP_REQUIRED: '无需妆造',
  RISK_UNBOOKED: '临近开播仍未预约',
  RISK_OVERTIME: '妆造已经超时',
  READY: '准备完成',
  NORMAL: '正常'
};

export default function ControlPage() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [roomId, setRoomId] = useState('');
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [currentTime, setCurrentTime] = useState(0);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadRooms = useCallback(async () => {
    try {
      const result = await api<Room[]>('/me/rooms');
      setRooms(result);
      setRoomId((current) => current || result[0]?.id || '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '直播间加载失败');
    }
  }, []);

  const loadBoard = useCallback(async () => {
    if (!roomId) return;
    try {
      setRows(
        await api<BoardRow[]>(`/control/rooms/${roomId}/makeup-board`)
      );
      setCurrentTime(new Date().getTime());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '直播间看板加载失败');
    }
  }, [roomId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadRooms());
    return () => window.cancelAnimationFrame(frame);
  }, [loadRooms]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadBoard());
    window.addEventListener('jishi:data-updated', loadBoard);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('jishi:data-updated', loadBoard);
    };
  }, [loadBoard]);

  const visible = useMemo(
    () =>
      rows?.filter((row) => {
        if (filter === 'ALL') return true;
        if (filter === 'RISK') return row.risk.startsWith('RISK_');
        if (filter === 'UNBOOKED') return !row.appointment_id;
        return row.appointment_status === filter;
      }) ?? [],
    [filter, rows]
  );

  const openPlan = async (row: BoardRow, mode: ActionPlan['mode']) => {
    setLoadingPlan(true);
    setError('');
    try {
      const result = await api<{ recommendations: Recommendation[] }>(
        `/appointments/recommendations?liveSessionId=${row.live_session_id}`
      );
      const recommendations =
        mode === 'REASSIGN'
          ? result.recommendations.filter(
              (item) => item.makeupArtistName !== row.makeup_artist_name
            )
          : result.recommendations;
      setPlan({ mode, row, recommendations });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约方案生成失败');
    } finally {
      setLoadingPlan(false);
    }
  };

  const confirmPlan = async (recommendation: Recommendation) => {
    if (!plan) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      if (plan.mode === 'BOOK') {
        await api('/appointments/quick-book', {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            liveSessionId: plan.row.live_session_id,
            makeupArtistId: recommendation.makeupArtistId
          })
        });
        setMessage('代预约已完成，主播和化妆师将收到最新安排');
      } else if (plan.row.appointment_id) {
        await api(`/appointments/${plan.row.appointment_id}/reschedule`, {
          method: 'PATCH',
          body: JSON.stringify({
            plannedStartAt: recommendation.startsAt,
            makeupArtistId: recommendation.makeupArtistId
          })
        });
        setMessage('化妆师已重新分配，相关人员将收到变更通知');
      }
      setPlan(null);
      await loadBoard();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约操作失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">ROOM CONTROL</p>
            <h1 className="title">今日直播间</h1>
            <p className="muted">
              按开播时间查看主播、妆造进度和风险；代预约与重新分配都会记录操作人。
            </p>
          </div>
          <button
            className="button secondary compact"
            type="button"
            onClick={() => void loadBoard()}
          >
            <RefreshCw size={16} aria-hidden />
            刷新
          </button>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}

        <section className="card control-toolbar">
          <label className="field compact-field">
            负责直播间
            <select
              value={roomId}
              onChange={(event) => {
                setRows(null);
                setRoomId(event.target.value);
              }}
            >
              {rooms?.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
          <div className="segmented-control" aria-label="任务筛选">
            {[
              ['ALL', '全部'],
              ['UNBOOKED', '未预约'],
              ['RISK', '存在风险'],
              ['IN_PROGRESS', '妆造中'],
              ['COMPLETED', '已完成']
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'active' : ''}
                type="button"
                onClick={() => setFilter(value ?? 'ALL')}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {!rows && roomId ? <LoadingState label="正在读取直播间进度…" /> : null}
        {rooms?.length === 0 ? (
          <EmptyState
            title="尚未分配直播间"
            description="管理员完成场控直播间数据范围配置后即可查看。"
          />
        ) : null}
        {rows && visible.length === 0 ? (
          <EmptyState
            title="当前筛选没有任务"
            description="切换筛选，或等待本地正式排班发布后刷新。"
          />
        ) : null}

        <section className="control-session-list">
          {visible.map((row) => {
            const minutesToLive = currentTime
              ? Math.ceil(
                  (new Date(row.live_starts_at).getTime() - currentTime) / 60_000
                )
              : null;
            const liveHasEnded = currentTime
              ? currentTime >= new Date(row.live_ends_at).getTime()
              : false;
            return (
              <article className="card control-session-card" key={row.live_session_id}>
                <div className="control-session-time">
                  <strong>{formatTime(row.live_starts_at)}</strong>
                  <small>
                    {minutesToLive === null
                      ? '正在计算'
                      : minutesToLive > 0
                      ? `${minutesToLive} 分钟后开播`
                      : !liveHasEnded
                        ? '正在直播'
                        : '直播已结束'}
                  </small>
                </div>
                <div className="control-person">
                  <PersonAvatar name={row.anchor_name} />
                  <span>
                    <strong>{row.anchor_name}</strong>
                    <TimeRange
                      startsAt={row.live_starts_at}
                      endsAt={row.live_ends_at}
                    />
                  </span>
                </div>
                <div className="control-makeup">
                  <StatusBadge
                    status={row.appointment_status ?? 'PENDING'}
                    {...(row.appointment_status ? {} : { label: '未预约' })}
                  />
                  <span>
                    {row.makeup_artist_name ?? '尚未安排化妆师'}
                    {row.planned_start_at && row.planned_end_at ? (
                      <TimeRange
                        startsAt={row.planned_start_at}
                        endsAt={row.planned_end_at}
                      />
                    ) : null}
                  </span>
                </div>
                <AlertBanner
                  tone={
                    row.risk_severity === 'URGENT'
                      ? 'danger'
                      : row.risk.startsWith('RISK_')
                        ? 'warning'
                        : 'success'
                  }
                  title={riskLabels[row.risk] ?? row.risk}
                />
                <div className="control-actions">
                  {!row.appointment_id ? (
                    <button
                      className="button compact"
                      type="button"
                      disabled={loadingPlan}
                      onClick={() => void openPlan(row, 'BOOK')}
                    >
                      <CalendarPlus size={16} aria-hidden />
                      代主播预约
                    </button>
                  ) : row.appointment_status === 'BOOKED' ? (
                    <button
                      className="button secondary compact"
                      type="button"
                      disabled={loadingPlan}
                      onClick={() => void openPlan(row, 'REASSIGN')}
                    >
                      <UsersRound size={16} aria-hidden />
                      重新分配
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>

        {plan ? (
          <div className="dialog-backdrop" role="presentation">
            <section className="dialog-card action-plan-dialog" role="dialog" aria-modal>
              <header>
                <div>
                  <p className="eyebrow">RECOMMENDATION</p>
                  <h2>
                    {plan.mode === 'BOOK' ? '确认代预约' : '选择新的化妆师'}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => setPlan(null)}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <p className="muted">
                {plan.row.anchor_name} · {formatTime(plan.row.live_starts_at)} 开播
              </p>
              {plan.recommendations.length ? (
                <div className="control-recommendation-list">
                  {plan.recommendations.slice(0, 4).map((recommendation) => (
                    <article key={recommendation.makeupArtistId}>
                      <div>
                        <PersonAvatar name={recommendation.makeupArtistName} size="sm" />
                        <span>
                          <strong>{recommendation.makeupArtistName}</strong>
                          <TimeRange
                            startsAt={recommendation.startsAt}
                            endsAt={recommendation.endsAt}
                          />
                        </span>
                      </div>
                      <p>{recommendation.reason}</p>
                      <button
                        className="button compact"
                        type="button"
                        disabled={saving}
                        onClick={() => void confirmPlan(recommendation)}
                      >
                        {saving ? '提交中…' : '确认此方案'}
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="暂无可用方案"
                  description="请调整班次、时间或化妆师临时状态后重试。"
                />
              )}
            </section>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
