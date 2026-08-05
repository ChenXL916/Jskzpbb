'use client';

import {
  BellRing,
  Clock3,
  RefreshCw,
  Save,
  Send,
  UsersRound
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

type DeliveryMode = 'WEBHOOK' | 'CHAT_ID' | 'NONE';

interface NotificationRule {
  id: string;
  code: string;
  name: string;
  description: string;
  triggerType: 'WEEKLY' | 'EVENT';
  weekday: number | null;
  sendTime: string | null;
  timezone: string;
  targetKey: string;
  enabled: boolean;
  effectiveFrom: string;
  lastEnqueuedAt: string | null;
  target: {
    key: string;
    label: string;
    configured: boolean;
    deliveryMode: DeliveryMode;
  };
}

interface GroupNotificationRecord {
  id: string;
  event_type: string;
  target_key: string;
  status: string;
  retry_count: number;
  next_attempt_at: string;
  last_error: string | null;
  scheduled_for: string | null;
  processed_at: string | null;
  created_at: string;
  message_preview: string;
}

interface GroupNotificationPage {
  items: GroupNotificationRecord[];
  total: number;
}

const weekdays = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' }
];

const statusLabels: Record<string, string> = {
  PENDING: '等待发送',
  RUNNING: '发送中',
  WAITING_CONFIGURATION: '等待机器人配置',
  FAILED: '发送失败',
  SUCCEEDED: '已发送',
  DEAD: '停止重试'
};

export default function ScheduleNotificationsPage() {
  const [rules, setRules] = useState<NotificationRule[] | null>(null);
  const [records, setRecords] = useState<GroupNotificationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const [ruleResult, recordResult] = await Promise.all([
        api<NotificationRule[]>('/admin/schedule-notifications/rules'),
        api<GroupNotificationPage>(
          '/admin/schedule-notifications/outbox?page=1&pageSize=20'
        )
      ]);
      setRules(ruleResult);
      setRecords(recordResult.items);
      setTotal(recordResult.total);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '排班通知配置加载失败');
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const patchRule = (id: string, patch: Partial<NotificationRule>) => {
    setRules((current) =>
      current?.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) ??
      null
    );
  };

  const saveRule = async (rule: NotificationRule) => {
    setBusyId(rule.id);
    setError('');
    setMessage('');
    try {
      const saved = await api<NotificationRule>(
        `/admin/schedule-notifications/rules/${rule.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            enabled: rule.enabled,
            ...(rule.triggerType === 'WEEKLY'
              ? { weekday: rule.weekday, sendTime: rule.sendTime }
              : {})
          })
        }
      );
      setRules((current) =>
        current?.map((item) => (item.id === saved.id ? saved : item)) ?? null
      );
      setMessage(`${saved.name}已保存，修改记录已写入操作日志`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '通知规则保存失败');
    } finally {
      setBusyId('');
    }
  };

  const sendTest = async (rule: NotificationRule) => {
    setBusyId(`test-${rule.id}`);
    setError('');
    setMessage('');
    try {
      await api(`/admin/schedule-notifications/rules/${rule.id}/test`, {
        method: 'POST'
      });
      setMessage(`已生成${rule.target.label}测试消息，将由发送队列处理`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '测试消息生成失败');
    } finally {
      setBusyId('');
    }
  };

  const retry = async (record: GroupNotificationRecord) => {
    setBusyId(`retry-${record.id}`);
    setError('');
    setMessage('');
    try {
      await api(`/admin/schedule-notifications/outbox/${record.id}/retry`, {
        method: 'POST'
      });
      setMessage('消息已重新进入发送队列');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '消息重试失败');
    } finally {
      setBusyId('');
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">SCHEDULE NOTIFICATIONS</p>
            <h1 className="title">排班提醒与群通知</h1>
            <p className="muted">
              管理排班开始提醒、下周排班发布和妆造预约即时群通知。
            </p>
          </div>
          <button
            className="button secondary compact"
            type="button"
            onClick={() => void load()}
          >
            <RefreshCw size={16} aria-hidden />
            刷新记录
          </button>
        </header>

        <AlertBanner tone="info" title="首版交付时间已锁定">
          DDL：2026年8月7日（周五）18:00。自动规则从该时间后生效；周四
          17:00 提醒排班，周六 18:00 发布下周排班。
        </AlertBanner>
        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}
        {!rules && !error ? <LoadingState label="正在读取群通知规则…" /> : null}
        {rules?.some((rule) => !rule.target.configured) ? (
          <AlertBanner tone="warning" title="群消息通道尚未配置完整">
            妆造预约群建议配置应用机器人群聊 ID：
            <code>FEISHU_MAKEUP_GROUP_CHAT_ID</code>。机器人必须已加入目标群并具备发言权限；
            化妆师绑定 Open ID 后，预约消息会自动@本人。配置完成后可在下方发送测试消息。
          </AlertBanner>
        ) : null}

        {rules ? (
          <section className="notification-rule-grid">
            {rules.map((rule) => (
              <article className="card notification-rule-card" key={rule.id}>
                <div className="notification-rule-heading">
                  <span className="metric-icon" aria-hidden>
                    {rule.triggerType === 'EVENT' ? (
                      <UsersRound size={18} />
                    ) : (
                      <Clock3 size={18} />
                    )}
                  </span>
                  <div>
                    <h2>{rule.name}</h2>
                    <p>{rule.description}</p>
                  </div>
                  <label className="toggle-field">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) =>
                        patchRule(rule.id, { enabled: event.target.checked })
                      }
                    />
                    <span>{rule.enabled ? '已启用' : '已停用'}</span>
                  </label>
                </div>

                <div className="notification-rule-controls">
                  {rule.triggerType === 'WEEKLY' ? (
                    <>
                      <label>
                        <span>每周</span>
                        <select
                          value={rule.weekday ?? 1}
                          onChange={(event) =>
                            patchRule(rule.id, {
                              weekday: Number(event.target.value)
                            })
                          }
                        >
                          {weekdays.map((weekday) => (
                            <option value={weekday.value} key={weekday.value}>
                              {weekday.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>发送时间</span>
                        <input
                          type="time"
                          value={rule.sendTime ?? '17:00'}
                          onChange={(event) =>
                            patchRule(rule.id, { sendTime: event.target.value })
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <div className="event-trigger-note">
                      <BellRing size={17} aria-hidden />
                      预约成功后立即生成消息
                    </div>
                  )}
                  <div className="notification-target">
                    <span>发送到</span>
                    <strong>{rule.target.label}</strong>
                    <StatusBadge
                      status={rule.target.configured ? 'SUCCEEDED' : 'WARNING'}
                      label={
                        rule.target.configured
                          ? rule.target.deliveryMode === 'WEBHOOK'
                            ? '机器人已配置'
                            : '应用群聊已配置'
                          : '等待提供机器人'
                      }
                    />
                  </div>
                </div>

                <div className="notification-rule-meta">
                  <span>
                    生效：{formatDateTime(rule.effectiveFrom)}
                  </span>
                  <span>
                    最近入队：
                    {rule.lastEnqueuedAt
                      ? formatDateTime(rule.lastEnqueuedAt)
                      : '尚未触发'}
                  </span>
                </div>

                <div className="notification-rule-actions">
                  <button
                    className="button secondary compact"
                    type="button"
                    disabled={
                      !rule.target.configured || busyId === `test-${rule.id}`
                    }
                    onClick={() => void sendTest(rule)}
                  >
                    <Send size={15} aria-hidden />
                    {busyId === `test-${rule.id}` ? '生成中…' : '发送测试'}
                  </button>
                  <button
                    className="button compact"
                    type="button"
                    disabled={busyId === rule.id}
                    onClick={() => void saveRule(rule)}
                  >
                    <Save size={15} aria-hidden />
                    {busyId === rule.id ? '保存中…' : '保存规则'}
                  </button>
                </div>
              </article>
            ))}
          </section>
        ) : null}

        <section className="card data-table-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DELIVERY OUTBOX</p>
              <h2>群消息发送记录</h2>
            </div>
            <span className="status-badge neutral">共 {total} 条</span>
          </div>
          {records.length ? (
            <div className="group-outbox-table">
              <div className="data-table-row data-table-heading group-outbox-row">
                <span>消息</span>
                <span>目标</span>
                <span>创建时间</span>
                <span>状态</span>
                <span>重试</span>
                <span>操作</span>
              </div>
              {records.map((record) => (
                <div className="data-table-row group-outbox-row" key={record.id}>
                  <span>
                    <strong>{record.event_type}</strong>
                    <small>
                      {record.message_preview || '预约消息将在发送时读取最新业务数据'}
                    </small>
                    {record.last_error ? (
                      <small className="danger-text">{record.last_error}</small>
                    ) : null}
                  </span>
                  <span>{record.target_key}</span>
                  <span>{formatDateTime(record.created_at)}</span>
                  <span>
                    <StatusBadge
                      status={record.status}
                      label={statusLabels[record.status] ?? record.status}
                    />
                  </span>
                  <span>{record.retry_count} 次</span>
                  <span>
                    {['FAILED', 'DEAD', 'WAITING_CONFIGURATION'].includes(
                      record.status
                    ) ? (
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={busyId === `retry-${record.id}`}
                        onClick={() => void retry(record)}
                      >
                        <RefreshCw size={14} aria-hidden />
                        重试
                      </button>
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <BellRing size={24} aria-hidden />
              <strong>还没有群消息发送记录</strong>
              <p>定时规则或妆造预约触发后，记录会出现在这里。</p>
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}
