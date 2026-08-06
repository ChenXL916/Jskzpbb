'use client';

import {
  CheckCircle2,
  CirclePlay,
  MoreHorizontal,
  TimerReset,
  X
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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

interface Task {
  id: string;
  status: string;
  anchor_name: string;
  room_name: string;
  planned_start_at: string;
  planned_end_at: string;
  live_starts_at: string;
  location?: string;
  original_requirement?: string | null;
}

interface ArtistDashboard {
  shift: {
    startsAt: string;
    endsAt: string;
    rawShiftValue: string;
  } | null;
  temporary_status: {
    statusType: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  } | null;
  task_count: number;
  completed_count: number;
  in_progress_count: number;
  next_task_at: string | null;
}

const exceptionOptions = [
  ['ANCHOR_NOT_ARRIVED', '主播未到'],
  ['ANCHOR_LATE', '主播迟到'],
  ['NEEDS_MORE_TIME', '需要延长时间'],
  ['NEEDS_ASSISTANCE', '需要其他化妆师协助'],
  ['HEALTH_ISSUE', '身体不适'],
  ['VENUE_ISSUE', '设备或场地问题']
] as const;

export default function MakeupTasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [dashboard, setDashboard] = useState<ArtistDashboard | null>(null);
  const [error, setError] = useState('');
  const [activeException, setActiveException] = useState<Task | null>(null);
  const [exceptionType, setExceptionType] = useState<
    (typeof exceptionOptions)[number][0]
  >(exceptionOptions[0][0]);
  const [exceptionNote, setExceptionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [taskResult, dashboardResult] = await Promise.all([
        api<Task[]>('/makeup-artist/tasks/today'),
        api<ArtistDashboard>('/makeup-artist/dashboard')
      ]);
      setTasks(taskResult);
      setDashboard(dashboardResult);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务加载失败');
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

  const transition = async (task: Task, action: 'start' | 'complete') => {
    setError('');
    try {
      await api(`/appointments/${task.id}/${action}`, { method: 'PATCH' });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务更新失败');
    }
  };

  const submitException = async () => {
    if (!activeException) return;
    setSubmitting(true);
    try {
      await api(`/appointments/${activeException.id}/exception`, {
        method: 'PATCH',
        body: JSON.stringify({
          exceptionType,
          note: exceptionNote || undefined
        })
      });
      setActiveException(null);
      setExceptionNote('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '异常反馈失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">MAKEUP WORKSPACE</p>
            <h1 className="title">今日妆造任务</h1>
            <p className="muted">主要流程只保留开始和完成，异常反馈放在任务更多操作中。</p>
          </div>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {dashboard ? (
          <section className="artist-dashboard-strip">
            <article className="card">
              <small>当前状态</small>
              <StatusBadge
                status={
                  dashboard.temporary_status?.statusType ??
                  (dashboard.in_progress_count ? 'IN_PROGRESS' : 'AVAILABLE')
                }
              />
            </article>
            <article className="card">
              <small>今日班次</small>
              <strong>
                {dashboard.shift
                  ? `${formatTime(dashboard.shift.startsAt)}—${formatTime(
                      dashboard.shift.endsAt
                    )}`
                  : '未排班'}
              </strong>
            </article>
            <article className="card">
              <small>今日任务</small>
              <strong>{dashboard.task_count}</strong>
            </article>
            <article className="card">
              <small>已完成</small>
              <strong>{dashboard.completed_count}</strong>
            </article>
            <article className="card">
              <small>下一任务</small>
              <strong>
                {dashboard.next_task_at
                  ? formatTime(dashboard.next_task_at)
                  : '暂无'}
              </strong>
            </article>
          </section>
        ) : null}

        {!tasks && !error ? <LoadingState label="正在读取今日任务…" /> : null}
        {tasks?.length === 0 ? (
          <EmptyState
            title="今天没有妆造任务"
            description="新的妆造预约会通过实时事件出现在时间轴中。"
          />
        ) : null}
        {tasks?.length ? (
          <section className="task-timeline">
            {tasks.map((task) => (
              <article className="card task-card" key={task.id}>
                <time className="task-time">
                  {formatTime(task.planned_start_at)}
                </time>
                <PersonAvatar name={task.anchor_name} />
                <div className="task-copy">
                  <div>
                    <h2>{task.anchor_name}</h2>
                    <StatusBadge status={task.status} />
                  </div>
                  <p>
                    {task.room_name} · 开播 {formatTime(task.live_starts_at)}
                  </p>
                  <small>
                    计划 <TimeRange
                      startsAt={task.planned_start_at}
                      endsAt={task.planned_end_at}
                    />
                    {task.location ? ` · ${task.location}` : ''}
                  </small>
                </div>
                <div className="task-actions">
                  {task.status === 'BOOKED' || task.status === 'EXCEPTION' ? (
                    <button
                      className="button"
                      onClick={() => void transition(task, 'start')}
                    >
                      <CirclePlay size={17} aria-hidden />
                      {task.status === 'EXCEPTION' ? '恢复妆造' : '开始妆造'}
                    </button>
                  ) : null}
                  {task.status === 'IN_PROGRESS' ||
                  task.status === 'EXCEPTION' ? (
                    <button
                      className="button"
                      onClick={() => void transition(task, 'complete')}
                    >
                      <CheckCircle2 size={17} aria-hidden />
                      完成妆造
                    </button>
                  ) : null}
                  {task.status === 'IN_PROGRESS' ? (
                    <button
                      className="button secondary"
                      aria-label="反馈任务异常"
                      onClick={() => setActiveException(task)}
                    >
                      <MoreHorizontal size={17} aria-hidden />
                      更多
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </section>
        ) : null}

        {activeException ? (
          <div className="dialog-backdrop" role="presentation">
            <section className="dialog-card" role="dialog" aria-modal="true">
              <header>
                <div>
                  <p className="eyebrow">TASK EXCEPTION</p>
                  <h2>反馈任务异常</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => setActiveException(null)}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <label>
                异常类型
                <select
                  value={exceptionType}
                  onChange={(event) =>
                    setExceptionType(
                      event.target.value as (typeof exceptionOptions)[number][0]
                    )
                  }
                >
                  {exceptionOptions.map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                补充说明
                <textarea
                  rows={4}
                  value={exceptionNote}
                  onChange={(event) => setExceptionNote(event.target.value)}
                  placeholder="说明当前情况，场控和主管会收到风险提醒"
                />
              </label>
              <footer>
                <button
                  className="button secondary"
                  onClick={() => setActiveException(null)}
                >
                  取消
                </button>
                <button
                  className="button danger"
                  disabled={submitting}
                  onClick={() => void submitException()}
                >
                  <TimerReset size={17} aria-hidden />
                  {submitting ? '提交中…' : '提交异常'}
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
