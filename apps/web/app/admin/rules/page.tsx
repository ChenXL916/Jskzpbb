'use client';

import { Save } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { SectionTabs } from '@/components/section-tabs';
import { api } from '@/lib/api';

interface SettingRecord {
  value: number | boolean;
  valueType: string;
  description: string;
}

const labels: Record<string, string> = {
  'booking.full_makeup_minutes': '完整妆造时长',
  'booking.anchor_lead_minutes': '主播开播前预约时间',
  'booking.touch_up_minutes': '补妆时长',
  'booking.trial_minutes': '试妆时长',
  'booking.live_buffer_minutes': '开播前缓冲',
  'booking.buffer_before_minutes': '预约前缓冲',
  'booking.buffer_after_minutes': '预约后缓冲',
  'booking.earliest_notice_minutes': '最早预约提前量',
  'booking.latest_cancel_minutes': '最晚取消时间',
  'risk.unbooked_warning_minutes': '未预约预警',
  'risk.incomplete_warning_minutes': '未完成预警',
  'booking.anchor_reschedule_enabled': '允许主播改期',
  'booking.field_control_proxy_enabled': '允许场控代预约',
  'booking.prefer_recent_artist': '优先最近合作化妆师',
  'booking.balance_workload': '均衡化妆师任务',
  'booking.auto_reassign': '自动重新分配'
};

export default function BookingRulesPage() {
  const [settings, setSettings] = useState<Record<string, SettingRecord> | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Record<string, SettingRecord>>('/admin/booking-rules')
      .then(setSettings)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '预约规则加载失败')
      );
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const values = Object.fromEntries(
        Object.entries(settings).map(([key, setting]) => [key, setting.value])
      );
      setSettings(
        await api<Record<string, SettingRecord>>('/admin/booking-rules', {
          method: 'PATCH',
          body: JSON.stringify({ settings: values })
        })
      );
      setMessage('预约规则已保存并写入操作日志');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预约规则保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">BUSINESS RULES</p>
            <h1 className="title">规则管理</h1>
            <p className="muted">排班、班次和妆造预约规则统一从这里进入，当前正在编辑预约规则。</p>
          </div>
        </header>
        <SectionTabs
          label="规则管理模块"
          activeHref="/admin/rules"
          items={[
            { href: '/admin/rules', label: '预约规则', description: '时长、缓冲与预警' },
            { href: '/admin/scheduling', label: '排班规则', description: '主播资格与月工时' },
            { href: '/admin/shifts', label: '班次规则', description: '时间、跨日和别名' }
          ]}
        />
        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}
        {!settings && !error ? <LoadingState label="正在读取预约规则…" /> : null}
        {settings ? (
          <form className="card settings-form" onSubmit={(event) => void submit(event)}>
            {Object.entries(settings).map(([key, setting]) => (
              <label className="setting-row" key={key}>
                <span>
                  <strong>{labels[key] ?? key}</strong>
                  <small>{setting.description}</small>
                </span>
                {setting.valueType === 'BOOLEAN' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(setting.value)}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        [key]: { ...setting, value: event.target.checked }
                      })
                    }
                  />
                ) : (
                  <span className="setting-input">
                    <input
                      type="number"
                      min={0}
                      value={Number(setting.value)}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          [key]: {
                            ...setting,
                            value: Number(event.target.value)
                          }
                        })
                      }
                    />
                    <em>分钟</em>
                  </span>
                )}
              </label>
            ))}
            <div className="form-actions">
              <button className="button" type="submit" disabled={saving}>
                <Save size={17} aria-hidden />
                {saving ? '保存中…' : '保存规则'}
              </button>
            </div>
          </form>
        ) : null}
      </main>
    </AppShell>
  );
}
