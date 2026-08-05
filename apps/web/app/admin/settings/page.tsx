'use client';

import {
  BellRing,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  Unplug
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';

interface DataBoundaryStatus {
  configured: boolean;
  tableSyncEnabled: boolean;
  dataAuthority: string;
  tableSyncMessage: string;
}

interface NotificationRule {
  id: string;
  code: string;
  enabled: boolean;
  target: {
    configured: boolean;
    label: string;
  };
}

export default function SystemSettingsPage() {
  const [dataBoundary, setDataBoundary] = useState<DataBoundaryStatus | null>(
    null
  );
  const [notificationRules, setNotificationRules] = useState<
    NotificationRule[] | null
  >(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [boundary, rules] = await Promise.all([
        api<DataBoundaryStatus>('/admin/feishu/status'),
        api<NotificationRule[]>('/admin/schedule-notifications/rules')
      ]);
      setDataBoundary(boundary);
      setNotificationRules(rules);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '系统配置状态加载失败');
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const configuredTargets = useMemo(
    () =>
      notificationRules?.filter((rule) => rule.target.configured).length ?? 0,
    [notificationRules]
  );
  const activeRules = useMemo(
    () => notificationRules?.filter((rule) => rule.enabled).length ?? 0,
    [notificationRules]
  );
  const loaded = Boolean(dataBoundary && notificationRules);

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">SYSTEM SETTINGS</p>
            <h1 className="title">系统设置</h1>
            <p className="muted">
              这里只显示全局运行边界；业务排班、人员和预约规则在对应管理工作区维护。
            </p>
          </div>
          {loaded ? <StatusBadge status="SUCCEEDED" label="配置状态已读取" /> : null}
        </header>

        {error ? (
          <AlertBanner
            tone="danger"
            title="系统配置状态暂时无法读取"
            action={
              <button className="button secondary compact" onClick={() => void load()}>
                重新加载
              </button>
            }
          >
            {error}
          </AlertBanner>
        ) : null}
        {!loaded && !error ? <LoadingState label="正在读取系统运行边界…" /> : null}

        {loaded ? (
          <>
            <section className="system-settings-grid">
              <article className="card system-setting-panel">
                <header>
                  <span className="metric-icon">
                    <Database size={18} aria-hidden />
                  </span>
                  <div>
                    <strong>业务数据来源</strong>
                    <small>飞书排班与本地预约的主从边界</small>
                  </div>
                  <StatusBadge status="SUCCEEDED" label="混合权威" />
                </header>
                <p>{dataBoundary?.tableSyncMessage}</p>
                <dl>
                  <div>
                    <dt>数据权威</dt>
                    <dd>飞书正式排班＋本地预约事务</dd>
                  </div>
                  <div>
                    <dt>飞书表格同步</dt>
                    <dd>{dataBoundary?.tableSyncEnabled ? '已启用' : '已停用'}</dd>
                  </div>
                </dl>
                <Link className="button secondary compact" href="/admin/feishu">
                  管理飞书排班数据源
                  <ExternalLink size={15} aria-hidden />
                </Link>
              </article>

              <article className="card system-setting-panel">
                <header>
                  <span className="metric-icon">
                    <BellRing size={18} aria-hidden />
                  </span>
                  <div>
                    <strong>通知渠道</strong>
                    <small>排班发布、预约和妆造状态消息</small>
                  </div>
                  <StatusBadge
                    status={configuredTargets > 0 ? 'SUCCEEDED' : 'WAITING_CONFIGURATION'}
                    label={`${configuredTargets}/${notificationRules?.length ?? 0} 个目标已配置`}
                  />
                </header>
                <p>
                  当前启用 {activeRules} 条通知规则。第三方消息失败不会回滚排班或预约，失败记录可重试。
                </p>
                <div className="settings-rule-statuses">
                  {notificationRules?.map((rule) => (
                    <span key={rule.id}>
                      {rule.target.configured ? (
                        <CheckCircle2 size={15} aria-hidden />
                      ) : (
                        <Unplug size={15} aria-hidden />
                      )}
                      {rule.target.label}
                    </span>
                  ))}
                </div>
                <Link className="button secondary compact" href="/admin/notifications">
                  配置通知渠道
                  <ExternalLink size={15} aria-hidden />
                </Link>
              </article>

              <article className="card system-setting-panel">
                <header>
                  <span className="metric-icon">
                    <KeyRound size={18} aria-hidden />
                  </span>
                  <div>
                    <strong>登录与权限</strong>
                    <small>系统账号 + 后端角色和数据范围</small>
                  </div>
                  <StatusBadge status="SUCCEEDED" label="本地账号" />
                </header>
                <p>
                  员工不需要飞书授权登录。所有页面和接口权限都由人员角色、功能权限和直播间数据范围共同决定。
                </p>
                <Link className="button secondary compact" href="/admin">
                  管理人员权限
                  <ExternalLink size={15} aria-hidden />
                </Link>
              </article>

              <article className="card system-setting-panel">
                <header>
                  <span className="metric-icon">
                    <Clock3 size={18} aria-hidden />
                  </span>
                  <div>
                    <strong>时间与安全</strong>
                    <small>跨日排班和业务时间统一口径</small>
                  </div>
                  <StatusBadge status="SUCCEEDED" label="Asia/Shanghai" />
                </header>
                <p>
                  全部业务时间以中国标准时间展示，数据库保存完整时间戳；预约和直播时间区间统一采用 [开始, 结束)。
                </p>
                <div className="system-security-notes">
                  <span><ShieldCheck size={15} aria-hidden /> 写操作记录操作人</span>
                  <span><ShieldCheck size={15} aria-hidden /> 密钥不返回前端</span>
                  <span><ShieldCheck size={15} aria-hidden /> 核心操作幂等防重</span>
                </div>
              </article>
            </section>

            {configuredTargets === 0 ? (
              <AlertBanner tone="warning" title="群通知目标尚未配置">
                本地排班和预约仍可正常运行，但排班发布和预约消息暂时不会送达飞书群。
              </AlertBanner>
            ) : null}
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
