'use client';

import { CheckCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface NotificationPage {
  items: Array<{
    id: string;
    event_type: string;
    title: string;
    body: string;
    severity: string;
    read_at: string | null;
    created_at: string;
  }>;
  unread: number;
}

export default function NotificationsPage() {
  const [data, setData] = useState<NotificationPage | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<NotificationPage>('/notifications?page=1&pageSize=50'));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '通知加载失败');
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

  const readAll = async () => {
    await api('/notifications/read-all', { method: 'PATCH' });
    await load();
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">NOTIFICATIONS</p>
            <h1 className="title">通知中心</h1>
            <p className="muted">预约、开妆、完成、异常和排班变化会集中到这里。</p>
          </div>
          {data?.unread ? (
            <button className="button secondary compact" onClick={() => void readAll()}>
              <CheckCheck size={17} aria-hidden />
              全部已读
            </button>
          ) : null}
        </header>
        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {!data && !error ? <LoadingState label="正在读取通知…" /> : null}
        {data?.items.length ? (
          <section className="card notification-list">
            {data.items.map((item) => (
              <article className={item.read_at ? 'is-read' : 'is-unread'} key={item.id}>
                <div>
                  <StatusBadge
                    status={
                      item.severity === 'ERROR'
                        ? 'URGENT'
                        : item.severity === 'WARNING'
                          ? 'WARNING'
                          : 'REMINDER'
                    }
                  />
                  <time>{formatDateTime(item.created_at)}</time>
                </div>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
              </article>
            ))}
          </section>
        ) : data ? (
          <EmptyState
            title="暂无通知"
            description="新的预约和任务状态变化会实时出现在这里。"
          />
        ) : null}
      </main>
    </AppShell>
  );
}
