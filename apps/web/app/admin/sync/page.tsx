'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface SyncPage {
  items: Array<{
    id: string;
    job_type: string;
    status: string;
    table_name: string | null;
    table_id: string | null;
    started_at: string | null;
    finished_at: string | null;
    fetched_count: number;
    created_count: number;
    updated_count: number;
    skipped_count: number;
    failed_count: number;
    retry_count: number;
    error_message: string | null;
  }>;
}

export default function SyncJobsPage() {
  const [data, setData] = useState<SyncPage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<SyncPage>('/admin/sync-jobs?page=1&pageSize=50')
      .then(setData)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '同步记录加载失败')
      );
  }, []);

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">SYNC CENTER</p>
            <h1 className="title">同步记录</h1>
            <p className="muted">查看人员排班与主播直播排班从飞书同步到程序的任务结果。</p>
          </div>
          <a className="button secondary compact" href="/admin/feishu">
            数据源管理
          </a>
        </header>
        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {!data && !error ? <LoadingState label="正在读取同步任务…" /> : null}
        {data?.items.length ? (
          <section className="card data-table-card">
            <div className="data-table-row data-table-heading sync-row">
              <span>数据表 / 类型</span>
              <span>状态</span>
              <span>开始时间</span>
              <span>拉取</span>
              <span>新增</span>
              <span>更新</span>
              <span>跳过</span>
              <span>失败</span>
            </div>
            {data.items.map((job) => (
              <article className="data-table-row sync-row" key={job.id}>
                <span>
                  <strong>{job.table_name ?? '全部数据表'}</strong>
                  <small>{job.job_type}</small>
                </span>
                <StatusBadge status={job.status} />
                <span>{job.started_at ? formatDateTime(job.started_at) : '等待中'}</span>
                <span>{job.fetched_count}</span>
                <span>{job.created_count}</span>
                <span>{job.updated_count}</span>
                <span>{job.skipped_count}</span>
                <span className={job.failed_count ? 'danger-text' : undefined}>
                  {job.failed_count}
                </span>
                {job.error_message ? (
                  <AlertBanner tone="danger" title={job.error_message} />
                ) : null}
              </article>
            ))}
          </section>
        ) : data ? (
          <EmptyState
            title="暂无同步任务"
            description="尚未执行飞书正式排班同步，可前往数据源管理或正式排班页立即同步。"
          />
        ) : null}
      </main>
    </AppShell>
  );
}
