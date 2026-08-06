'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';

interface ShiftTemplate {
  id: string;
  name: string;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes?: number | null;
  crosses_midnight: boolean;
  bookable: boolean;
  confirmation_required: boolean;
  segments: Array<{ startTime: string; endTime: string }>;
  aliases: string[];
}

function segmentText(row: ShiftTemplate) {
  if (row.start_time && row.end_time && row.segments?.length > 1) {
    return `${row.start_time.slice(0, 5)}—${row.end_time.slice(
      0,
      5
    )}（可预约 ${row.segments
      .map(
        (segment) =>
          `${segment.startTime.slice(0, 5)}—${segment.endTime.slice(0, 5)}`
      )
      .join('，')}）`;
  }
  if (row.segments?.length) {
    return row.segments
      .map(
        (segment) =>
          `${segment.startTime.slice(0, 5)}—${segment.endTime.slice(0, 5)}`
      )
      .join('，');
  }
  if (row.duration_minutes) {
    return `${row.duration_minutes / 60} 小时（开始时间需确认）`;
  }
  return `${row.start_time?.slice(0, 5) ?? '—'}—${row.end_time?.slice(0, 5) ?? '—'}`;
}

export default function ShiftsPage() {
  const [rows, setRows] = useState<ShiftTemplate[] | null>(null);
  const [editing, setEditing] = useState<ShiftTemplate | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api<ShiftTemplate[]>('/admin/shift-templates'));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '班次模板加载失败');
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    const data = new FormData(event.currentTarget);
    const segments = String(data.get('segments') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const [startTime, endTime] = value.split('-').map((part) => part.trim());
        return { startTime, endTime };
      })
      .filter(
        (segment): segment is { startTime: string; endTime: string } =>
          Boolean(segment.startTime && segment.endTime)
      );
    const payload = {
      name: String(data.get('name') ?? ''),
      startTime: data.get('startTime') || undefined,
      endTime: data.get('endTime') || undefined,
      durationMinutes: data.get('durationMinutes')
        ? Number(data.get('durationMinutes'))
        : undefined,
      crossesMidnight: data.get('crossesMidnight') === 'on',
      bookable: data.get('bookable') === 'on',
      confirmationRequired: data.get('confirmationRequired') === 'on',
      segments,
      aliases: String(data.get('aliases') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    };

    try {
      await api(
        editing
          ? `/admin/shift-templates/${editing.id}`
          : '/admin/shift-templates',
        {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify(payload)
        }
      );
      setMessage(editing ? '班次模板已更新' : '班次模板已创建');
      setEditing(null);
      event.currentTarget.reset();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '班次模板保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">SHIFT DICTIONARY</p>
            <h1 className="title">班次模板</h1>
            <p className="muted">
              行政班 09:30—18:30、培训班 10:00—16:00；自由班只有
              7 小时或 4 小时时长，排班时必须确认开始时间。
            </p>
          </div>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}

        <form
          key={editing?.id ?? 'new'}
          className="card settings-form shift-form"
          onSubmit={(event) => void save(event)}
        >
          <div className="form-section-heading">
            <strong>{editing ? `编辑：${editing.name}` : '新增班次模板'}</strong>
            {editing ? (
              <button
                className="button secondary compact"
                type="button"
                onClick={() => setEditing(null)}
              >
                取消编辑
              </button>
            ) : null}
          </div>
          <div className="grid three-column form-section">
            <label className="field">
              班次名称
              <input
                name="name"
                required
                defaultValue={editing?.name}
                placeholder="例如 行政班"
              />
            </label>
            <label className="field">
              开始时间
              <input
                name="startTime"
                type="time"
                defaultValue={editing?.start_time?.slice(0, 5)}
              />
            </label>
            <label className="field">
              结束时间
              <input
                name="endTime"
                type="time"
                defaultValue={editing?.end_time?.slice(0, 5)}
              />
            </label>
          </div>
          <div className="grid two-column form-section">
            <label className="field">
              分段时间
              <input
                name="segments"
                defaultValue={editing?.segments
                  ?.map(
                    (segment) =>
                      `${segment.startTime.slice(0, 5)}-${segment.endTime.slice(0, 5)}`
                  )
                  .join(',')}
                placeholder="09:30-12:30,14:00-18:30"
              />
            </label>
            <label className="field">
              别名
              <input
                name="aliases"
                defaultValue={editing?.aliases?.join(',')}
                placeholder="早,早班,行政班"
              />
            </label>
          </div>
          <div className="grid two-column form-section">
            <label className="field">
              只有时长时填写分钟数
              <input
                name="durationMinutes"
                type="number"
                min="1"
                defaultValue={editing?.duration_minutes ?? undefined}
              />
            </label>
            <div className="checkbox-grid">
              <label>
                <input
                  name="crossesMidnight"
                  type="checkbox"
                  defaultChecked={editing?.crosses_midnight}
                />
                跨日
              </label>
              <label>
                <input
                  name="bookable"
                  type="checkbox"
                  defaultChecked={editing?.bookable ?? true}
                />
                可预约
              </label>
              <label>
                <input
                  name="confirmationRequired"
                  type="checkbox"
                  defaultChecked={editing?.confirmation_required}
                />
                必须人工确认
              </label>
            </div>
          </div>
          <div className="form-actions">
            <button className="button" type="submit" disabled={saving}>
              {saving ? '保存中…' : editing ? '保存修改' : '新增班次模板'}
            </button>
          </div>
        </form>

        {!rows ? <LoadingState label="正在读取班次配置…" /> : null}
        {rows ? (
          <div className="card data-table-card">
            <div className="shift-template-row heading">
              <span>名称</span>
              <span>有效时间</span>
              <span>别名</span>
              <span>跨日</span>
              <span>预约规则</span>
              <span>操作</span>
            </div>
            {rows.map((row) => (
              <article className="shift-template-row" key={row.id}>
                <strong>{row.name}</strong>
                <span>{segmentText(row)}</span>
                <span>{row.aliases.length ? row.aliases.join('、') : '—'}</span>
                <span>{row.crosses_midnight ? '是' : '否'}</span>
                <StatusBadge
                  status={row.bookable ? 'AVAILABLE' : 'UNAVAILABLE'}
                  label={
                    row.confirmation_required
                      ? '需确认'
                      : row.bookable
                        ? '可预约'
                        : '不可预约'
                  }
                />
                <button
                  className="button secondary compact"
                  type="button"
                  onClick={() => setEditing(row)}
                >
                  编辑
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
