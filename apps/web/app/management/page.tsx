'use client';

import {
  Activity,
  Brush,
  CheckCircle2,
  Clock3,
  Radio,
  Sparkles,
  UsersRound
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { AppShell } from '@/components/app-shell';
import { api, formatDateTime } from '@/lib/api';

interface Dashboard {
  metrics: {
    live_session_count: number;
    booked_count: number;
    in_progress_count: number;
    completed_count: number;
    risk_count: number;
    makeup_artist_on_duty_count: number;
    field_control_on_duty_count: number;
  };
  rooms: Array<{
    id: string;
    name: string;
    current_session_count: number;
    next_session_at: string | null;
    booked_count: number;
    in_progress_count: number;
  }>;
  risks: Array<{
    id: string;
    severity: string;
    title: string;
    description: string;
    room_name: string | null;
    due_at: string | null;
  }>;
}

interface Workload {
  id: string;
  display_name: string;
  task_count: number;
  completed_count: number;
  planned_minutes: number;
  next_task_at: string | null;
}

const metricDefinitions = [
  ['今日直播', 'live_session_count', Radio],
  ['已预约', 'booked_count', Clock3],
  ['妆造中', 'in_progress_count', Sparkles],
  ['已完成', 'completed_count', CheckCircle2],
  ['风险任务', 'risk_count', Activity],
  ['化妆师在岗', 'makeup_artist_on_duty_count', Brush],
  ['场控在岗', 'field_control_on_duty_count', UsersRound]
] as const;

export default function ManagementPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [workload, setWorkload] = useState<Workload[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [dashboardResult, workloadResult] = await Promise.all([
        api<Dashboard>('/management/dashboard'),
        api<Workload[]>('/management/workload')
      ]);
      setDashboard(dashboardResult);
      setWorkload(workloadResult);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '主管工作台加载失败');
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

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">OPERATIONS OVERVIEW</p>
            <h1 className="title">运营总览</h1>
            <p className="muted">
              今日直播间、妆造执行、人力负载与风险集中在一个工作台。
            </p>
          </div>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {!dashboard && !error ? <LoadingState label="正在汇总今日运营数据…" /> : null}

        {dashboard ? (
          <>
            <section className="metric-grid">
              {metricDefinitions.map(([label, key, Icon]) => (
                <article className="metric-card" key={key}>
                  <span className="metric-icon">
                    <Icon size={18} aria-hidden />
                  </span>
                  <strong>{dashboard.metrics[key] ?? 0}</strong>
                  <small>{label}</small>
                </article>
              ))}
            </section>

            <section className="operations-grid">
              <div className="card panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">LIVE ROOMS</p>
                    <h2>直播间实时状态</h2>
                  </div>
                </div>
                <div className="room-status-list">
                  {dashboard.rooms.map((room) => (
                    <article key={room.id}>
                      <div>
                        <strong>{room.name}</strong>
                        <small>
                          {room.current_session_count > 0
                            ? `${room.current_session_count} 场正在直播`
                            : room.next_session_at
                              ? `下一场 ${formatDateTime(room.next_session_at)}`
                              : '今日暂无后续场次'}
                        </small>
                      </div>
                      <div className="room-status-counts">
                        <span>{room.booked_count} 已预约</span>
                        <span>{room.in_progress_count} 妆造中</span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>

              <div className="card panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">RISKS</p>
                    <h2>待处理风险</h2>
                  </div>
                  <a className="text-link" href="/risks">
                    查看全部
                  </a>
                </div>
                {dashboard.risks.length ? (
                  <div className="risk-compact-list">
                    {dashboard.risks.slice(0, 6).map((risk) => (
                      <article key={risk.id}>
                        <StatusBadge status={risk.severity} />
                        <div>
                          <strong>{risk.title}</strong>
                          <small>
                            {risk.room_name ?? '跨直播间'} · {risk.description}
                          </small>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="当前没有待处理风险"
                    description="系统会持续检查未预约、超时、班次变化和人员冲突。"
                  />
                )}
              </div>
            </section>

            <section className="card panel" id="statistics">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">WORKLOAD</p>
                  <h2>化妆师今日负载</h2>
                </div>
              </div>
              {workload.length ? (
                <div className="workload-table">
                  <div className="workload-row heading">
                    <span>化妆师</span>
                    <span>任务</span>
                    <span>已完成</span>
                    <span>计划时长</span>
                    <span>下一任务</span>
                  </div>
                  {workload.map((artist) => (
                    <div className="workload-row" key={artist.id}>
                      <strong>{artist.display_name}</strong>
                      <span>{artist.task_count}</span>
                      <span>{artist.completed_count}</span>
                      <span>{artist.planned_minutes} 分钟</span>
                      <span>
                        {artist.next_task_at
                          ? formatDateTime(artist.next_task_at)
                          : '暂无'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="今日暂无妆造任务"
                  description="化妆师班次仍可在妆造日程中查看。"
                />
              )}
            </section>
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
