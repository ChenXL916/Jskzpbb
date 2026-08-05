'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { EmptyState } from '@/components/empty-state';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface RiskItem {
  id: string;
  severity: 'REMINDER' | 'WARNING' | 'URGENT';
  title: string;
  description: string;
  suggestion: string | null;
  room_name: string | null;
  person_name: string | null;
  owner_name: string | null;
  due_at: string | null;
  occurred_at: string;
}

export default function RiskPage() {
  const [items, setItems] = useState<RiskItem[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await api<RiskItem[]>('/risks'));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '风险数据加载失败');
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

  const resolve = async (id: string) => {
    try {
      await api(`/risks/${id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify({})
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '风险处理失败');
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">RISK CENTER</p>
            <h1 className="title">风险中心</h1>
            <p className="muted">按紧急程度处理可能影响开播的妆造和排班问题。</p>
          </div>
        </header>
        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {!items && !error ? <LoadingState label="正在检查排班风险…" /> : null}
        {items?.length ? (
          <section className="risk-center-list">
            {items.map((item) => (
              <article className="card risk-card" key={item.id}>
                <div className="risk-card-heading">
                  <StatusBadge status={item.severity} />
                  <span>
                    {item.due_at
                      ? `截止 ${formatDateTime(item.due_at)}`
                      : formatDateTime(item.occurred_at)}
                  </span>
                </div>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                <dl>
                  <div>
                    <dt>直播间</dt>
                    <dd>{item.room_name ?? '未关联'}</dd>
                  </div>
                  <div>
                    <dt>影响人员</dt>
                    <dd>{item.person_name ?? '待确认'}</dd>
                  </div>
                  <div>
                    <dt>负责人</dt>
                    <dd>{item.owner_name ?? '待认领'}</dd>
                  </div>
                </dl>
                {item.suggestion ? (
                  <AlertBanner tone="info" title="建议处理">
                    {item.suggestion}
                  </AlertBanner>
                ) : null}
                <div className="risk-card-actions">
                  <button
                    className="button secondary compact"
                    onClick={() => void resolve(item.id)}
                  >
                    标记已处理
                  </button>
                </div>
              </article>
            ))}
          </section>
        ) : items ? (
          <EmptyState
            title="当前没有待处理风险"
            description="程序排班、预约和人员状态变化会在这里自动生成风险。"
          />
        ) : null}
      </main>
    </AppShell>
  );
}
