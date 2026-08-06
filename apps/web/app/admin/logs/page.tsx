'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { SectionTabs } from '@/components/section-tabs';
import { api, formatDateTime } from '@/lib/api';

interface LogPage {
  items: Array<{
    id: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    actor_name: string | null;
    created_at: string;
  }>;
}

const actionLabels: Record<string, string> = {
  LOGIN: '登录',
  UPDATE_PERSON_PERMISSIONS: '修改人员权限',
  UPDATE_BOOKING_RULES: '修改预约规则',
  SET_TEMPORARY_STATUS: '设置临时状态',
  QUICK_BOOK: '创建预约',
  START: '开始妆造',
  COMPLETE: '完成妆造',
  CANCEL: '取消预约',
  EXCEPTION: '异常反馈'
};

export default function OperationLogsPage() {
  const [data, setData] = useState<LogPage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<LogPage>('/admin/operation-logs?page=1&pageSize=100')
      .then(setData)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '操作日志加载失败')
      );
  }, []);

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">DATA & AUDIT</p>
            <h1 className="title">数据管理</h1>
            <p className="muted">集中查看操作审计、历史同步和数据权威边界；当前显示操作日志。</p>
          </div>
        </header>
        <SectionTabs
          label="数据管理模块"
          activeHref="/admin/logs"
          items={[
            { href: '/admin/logs', label: '操作日志', description: '人员与业务操作审计' },
            { href: '/admin/sync', label: '历史同步', description: '只读任务与失败记录' },
            { href: '/admin/feishu', label: '数据边界', description: '本地权威与历史映射' }
          ]}
        />
        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {!data && !error ? <LoadingState label="正在读取操作日志…" /> : null}
        {data?.items.length ? (
          <section className="card activity-list">
            {data.items.map((item) => (
              <article key={item.id}>
                <span className="activity-dot" aria-hidden />
                <div>
                  <strong>{actionLabels[item.action] ?? item.action}</strong>
                  <p>
                    {item.actor_name ?? '系统'} · {item.resource_type}
                  </p>
                </div>
                <time>{formatDateTime(item.created_at)}</time>
              </article>
            ))}
          </section>
        ) : data ? (
          <EmptyState
            title="暂无操作日志"
            description="关键业务操作发生后会自动记录。"
          />
        ) : null}
      </main>
    </AppShell>
  );
}
