'use client';

import {
  CheckCircle2,
  Database,
  RefreshCw,
  Send,
  Unplug
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface Status {
  configured: boolean;
  syncEnabled: boolean;
  tableSyncEnabled: boolean;
  enabledScheduleTableCount: number;
  lastScheduleSyncAt?: string | null;
  dataAuthority: string;
  tableSyncMessage: string;
  appTokenMasked?: string | null;
}

interface TableMapping {
  id: string;
  table_id: string;
  table_name: string;
  business_type: string;
  sync_direction: string;
  enabled: boolean;
  field_mapping_count: number;
  last_synced_at?: string | null;
}

interface AppointmentWritebackStatus {
  enabled: boolean;
  clientConfigured: boolean;
  mapping: null | {
    table_id: string;
    table_name: string;
    enabled: boolean;
    sync_direction: string;
    field_count: number;
  };
  outbox: Record<string, number>;
}

const businessLabels: Record<string, string> = {
  STAFF_MONTHLY_SCHEDULE: '人员月排班',
  LIVE_ROOM_MONTHLY_SCHEDULE: '主播直播排班',
  MAKEUP_APPOINTMENTS: '化妆预约（未启用）'
};

export default function FeishuBoundaryPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mappings, setMappings] = useState<TableMapping[]>([]);
  const [writeback, setWriteback] =
    useState<AppointmentWritebackStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [nextStatus, nextMappings, nextWriteback] = await Promise.all([
      api<Status>('/admin/feishu/status'),
      api<TableMapping[]>('/admin/feishu/table-mappings'),
      api<AppointmentWritebackStatus>(
        '/admin/feishu/appointment-writeback/status'
      )
    ]);
    setStatus(nextStatus);
    setMappings(nextMappings);
    setWriteback(nextWriteback);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((reason: Error) => setError(reason.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run = async (action: 'test' | 'sync') => {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      if (action === 'test') {
        const result = await api<{ tableCount: number }>(
          '/admin/feishu/test-connection',
          { method: 'POST' }
        );
        setNotice(`连接成功，当前 Base 可读取 ${result.tableCount} 张表。`);
      } else {
        const results = await api<Array<{ fetched: number; failed: number }>>(
          '/admin/feishu/sync',
          { method: 'POST' }
        );
        const fetched = results.reduce((sum, item) => sum + item.fetched, 0);
        const failed = results.reduce((sum, item) => sum + item.failed, 0);
        setNotice(`排班同步完成：读取 ${fetched} 条，失败 ${failed} 条。`);
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const configureWriteback = async () => {
    setBusy('configure-writeback');
    setError('');
    setNotice('');
    try {
      const result = await api<{
        enabled: boolean;
        mappedFields: unknown[];
        missingRequired: string[];
      }>('/admin/feishu/appointment-mapping/auto-configure', {
        method: 'POST'
      });
      setNotice(
        result.enabled
          ? `预约写回映射已启用，共识别 ${result.mappedFields.length} 个真实字段。`
          : `映射未启用，仍缺少：${result.missingRequired.join('、')}`
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约写回映射失败');
    } finally {
      setBusy('');
    }
  };

  const drainWriteback = async () => {
    setBusy('drain-writeback');
    setError('');
    setNotice('');
    try {
      const result = await api<{ processed: number; enabled: boolean }>(
        '/admin/feishu/appointment-writeback/drain',
        { method: 'POST' }
      );
      setNotice(
        result.enabled
          ? `本次已处理 ${result.processed} 条预约写回任务。`
          : '预约写回开关尚未启用，请检查后端环境变量。'
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约写回处理失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <AppShell>
      <main className="page">
        <p className="eyebrow">FEISHU SCHEDULE SOURCE</p>
        <h1 className="title">飞书正式排班数据源</h1>
        <p className="muted">
          正式人员排班和主播直播时段从飞书读取；程序继续负责预约事务、冲突校验、状态、通知和审计。
        </p>

        {!status && !error ? <LoadingState label="正在检查飞书排班连接…" /> : null}
        {error ? <section className="card hero-card alert-banner danger">{error}</section> : null}
        {notice ? <section className="card hero-card alert-banner success">{notice}</section> : null}

        {status ? (
          <>
            <div className="dashboard-grid" style={{ marginTop: '1rem' }}>
              <section className="card hero-card">
                <span className="status success">
                  <Database size={14} /> 飞书排班权威模式
                </span>
                <h2>{status.enabledScheduleTableCount} 张正式排班表已启用</h2>
                <p className="muted">{status.tableSyncMessage}</p>
                <ul className="compact-list">
                  <li>人员月排班：飞书 → 程序，只读同步。</li>
                  <li>主播直播排班：飞书 → 程序，只读同步并合并连续时段。</li>
                  <li>妆造预约仍由程序创建，不会被飞书预约表覆盖。</li>
                </ul>
                <div className="button-row">
                  <button className="button secondary" disabled={Boolean(busy)} onClick={() => void run('test')}>
                    {busy === 'test' ? <RefreshCw className="spin" size={16} /> : <Unplug size={16} />}
                    测试连接
                  </button>
                  <button className="button" disabled={Boolean(busy)} onClick={() => void run('sync')}>
                    <RefreshCw className={busy === 'sync' ? 'spin' : ''} size={16} />
                    {busy === 'sync' ? '正在同步…' : '立即同步正式排班'}
                  </button>
                </div>
              </section>

              <section className="card hero-card">
                <span className={`status ${status.configured ? 'success' : 'warning'}`}>
                  {status.configured ? <CheckCircle2 size={14} /> : <Unplug size={14} />}
                  {status.configured ? '飞书凭据已配置' : '飞书凭据待配置'}
                </span>
                <h2>Base {status.appTokenMasked ?? '未配置'}</h2>
                <p className="muted">
                  {status.lastScheduleSyncAt
                    ? `最近同步：${formatDateTime(status.lastScheduleSyncAt)}`
                    : '尚无正式排班同步记录'}
                </p>
                <span className="status info">
                  <Send size={14} /> 群通知与表格同步相互独立
                </span>
              </section>
            </div>

            <section className="card table-wrap" style={{ marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>飞书表格</th>
                    <th>业务用途</th>
                    <th>同步方向</th>
                    <th>字段映射</th>
                    <th>状态</th>
                    <th>最近同步</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((mapping) => (
                    <tr key={mapping.id}>
                      <td><strong>{mapping.table_name}</strong><small>{mapping.table_id}</small></td>
                      <td>{businessLabels[mapping.business_type] ?? mapping.business_type}</td>
                      <td>{mapping.sync_direction === 'FEISHU_TO_LOCAL' ? '飞书 → 程序' : mapping.sync_direction}</td>
                      <td>{mapping.field_mapping_count} 个字段</td>
                      <td><span className={`status ${mapping.enabled ? 'success' : ''}`}>{mapping.enabled ? '已启用' : '未启用'}</span></td>
                      <td>{mapping.last_synced_at ? formatDateTime(mapping.last_synced_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {writeback ? (
              <section className="card hero-card" style={{ marginTop: '1rem' }}>
                <span
                  className={`status ${
                    writeback.enabled && writeback.mapping?.enabled
                      ? 'success'
                      : 'warning'
                  }`}
                >
                  <Send size={14} /> 预约写回飞书
                </span>
                <h2>
                  {writeback.mapping?.table_name ?? '尚未识别化妆师预约表'}
                </h2>
                <p className="muted">
                  本地预约为业务主数据，新增、改期、开始和完成通过可靠队列写回飞书；飞书不会反向覆盖有效预约。
                </p>
                <ul className="compact-list">
                  <li>字段映射：{writeback.mapping?.field_count ?? 0} 个</li>
                  <li>等待写回：{writeback.outbox.PENDING ?? 0} 条</li>
                  <li>失败待重试：{writeback.outbox.FAILED ?? 0} 条</li>
                  <li>永久失败：{writeback.outbox.DEAD ?? 0} 条</li>
                </ul>
                <div className="button-row">
                  <button
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void configureWriteback()}
                  >
                    <Database size={16} />
                    {busy === 'configure-writeback'
                      ? '正在识别字段…'
                      : '自动识别预约表字段'}
                  </button>
                  <button
                    className="button"
                    disabled={Boolean(busy) || !writeback.mapping?.enabled}
                    onClick={() => void drainWriteback()}
                  >
                    <RefreshCw
                      className={busy === 'drain-writeback' ? 'spin' : ''}
                      size={16}
                    />
                    立即处理写回队列
                  </button>
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
