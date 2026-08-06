'use client';

import {
  BadgeCheck,
  CalendarRange,
  Database,
  Gauge,
  History,
  Import,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UsersRound
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AlertBanner, StatusBadge } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';

interface RoomEligibility {
  roomId: string;
  roomName: string;
  eligible: boolean;
  priority: number;
  reason?: string | null;
}

interface AnchorProfile {
  id: string;
  display_name: string;
  employment_type: string;
  employment_status: string;
  employment_started_on?: string | null;
  employment_ended_on?: string | null;
  eligible_for_auto_schedule: boolean;
  target_monthly_minutes?: number | null;
  min_monthly_minutes?: number | null;
  max_monthly_minutes?: number | null;
  preferred_time_band_codes: string[];
  avoided_time_band_codes: string[];
  rooms: RoomEligibility[];
}

interface AvailabilityRule {
  id: string;
  anchor_id: string;
  anchor_name: string;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
  availability_type: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED' | 'AVOID';
}

interface ImportJob {
  id: string;
  import_type: string;
  source_file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  created_at: string;
  validation_errors?: Array<{ rowNumber: number; errors: string[] }>;
}

interface SchedulingConfiguration {
  dataSources: Array<{
    id: string;
    name: string;
    source_type: string;
    is_primary: boolean;
    enabled: boolean;
    status: string;
  }>;
  activeRuleSet?: {
    id: string;
    name: string;
    version: number;
    max_session_minutes: number;
    min_rest_minutes: number;
    full_time_min_monthly_minutes: number;
    full_time_target_monthly_minutes: number;
    full_time_max_monthly_minutes: number;
    business_priority: number;
    ability_weight: number;
    full_time_priority: number;
    part_time_fairness: number;
    development_ratio: number;
    golden_time_protection: number;
    max_consecutive_overnight_sessions: number;
  } | null;
  coverageTemplates: Array<{
    id: string;
    room_name: string;
    name: string;
    slots: unknown[];
  }>;
  profiles: AnchorProfile[];
  availabilityExceptions: unknown[];
  availabilityRules: AvailabilityRule[];
}

const importTypeLabels: Record<string, string> = {
  ANCHORS: '主播主数据',
  ELIGIBILITY: '直播间资格',
  AVAILABILITY: '可用性例外',
  ABILITY: '主播能力',
  COVERAGE: '直播间覆盖模板'
};

const weekLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const minuteText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const hoursValue = (minutes?: number | null) =>
  minutes == null ? '' : minutes / 60;

const minutesValue = (value: string) =>
  value === '' ? null : Math.round(Number(value) * 60);

const employmentLabel = (value: string) =>
  value === 'FULL_TIME' ? '全职' : value === 'PART_TIME' ? '兼职' : '待确认';

export default function SchedulingConfigurationPage() {
  const [configuration, setConfiguration] =
    useState<SchedulingConfiguration | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AnchorProfile>>({});
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [importType, setImportType] = useState('ANCHORS');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [ruleDraft, setRuleDraft] = useState({
    anchorId: '',
    dayOfWeek: 1,
    startMinute: 0,
    endMinute: 1440,
    availabilityType: 'AVAILABLE'
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [strategyDraft, setStrategyDraft] = useState({
    businessPriority: 90,
    abilityWeight: 80,
    fullTimePriority: 80,
    partTimeFairness: 10,
    developmentRatio: 25,
    goldenTimeProtection: 80
  });

  const load = useCallback(async () => {
    try {
      const [result, jobs] = await Promise.all([
        api<SchedulingConfiguration>('/admin/scheduling/configuration'),
        api<ImportJob[]>('/admin/scheduling/imports')
      ]);
      setConfiguration(result);
      setImportJobs(jobs);
      setDrafts(
        Object.fromEntries(
          result.profiles.map((profile) => [profile.id, { ...profile }])
        )
      );
      if (result.activeRuleSet) {
        setStrategyDraft({
          businessPriority: result.activeRuleSet.business_priority,
          abilityWeight: result.activeRuleSet.ability_weight,
          fullTimePriority: result.activeRuleSet.full_time_priority,
          partTimeFairness: result.activeRuleSet.part_time_fairness,
          developmentRatio: result.activeRuleSet.development_ratio,
          goldenTimeProtection: result.activeRuleSet.golden_time_protection
        });
      }
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '排班配置加载失败');
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const updateDraft = (
    id: string,
    patch: Partial<AnchorProfile>
  ) =>
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id]!, ...patch }
    }));

  const saveStrategy = async () => {
    setBusy('strategy');
    setError('');
    setNotice('');
    try {
      await api('/admin/scheduling/strategy', {
        method: 'PATCH',
        body: JSON.stringify(strategyDraft)
      });
      setNotice('经营优先排班策略已保存，新生成的草案将立即使用');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '排班策略保存失败');
    } finally {
      setBusy('');
    }
  };

  const saveProfile = async (id: string) => {
    const profile = drafts[id];
    if (!profile) return;
    setBusy(`profile:${id}`);
    setError('');
    setNotice('');
    try {
      const payload: {
        eligibleForAutoSchedule: boolean;
        targetMonthlyMinutes?: number;
        minMonthlyMinutes?: number;
        maxMonthlyMinutes?: number;
        employmentStartedOn: string | null;
        employmentEndedOn: string | null;
        preferredTimeBandCodes: string[];
        avoidedTimeBandCodes: string[];
      } = {
        eligibleForAutoSchedule: profile.eligible_for_auto_schedule,
        employmentStartedOn: profile.employment_started_on || null,
        employmentEndedOn: profile.employment_ended_on || null,
        preferredTimeBandCodes: profile.preferred_time_band_codes,
        avoidedTimeBandCodes: profile.avoided_time_band_codes
      };
      if (profile.target_monthly_minutes != null) {
        payload.targetMonthlyMinutes = profile.target_monthly_minutes;
      }
      if (profile.min_monthly_minutes != null) {
        payload.minMonthlyMinutes = profile.min_monthly_minutes;
      }
      if (profile.max_monthly_minutes != null) {
        payload.maxMonthlyMinutes = profile.max_monthly_minutes;
      }
      await api(`/admin/scheduling/anchors/${id}/profile`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      setNotice(`${profile.display_name} 的自动排班配置已保存`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '主播配置保存失败');
    } finally {
      setBusy('');
    }
  };

  const uploadImport = async () => {
    if (!importFile) {
      setError('请先选择 CSV 或 XLSX 文件');
      return;
    }
    setBusy('import:upload');
    setError('');
    setNotice('');
    try {
      const form = new FormData();
      form.append('file', importFile);
      const job = await api<ImportJob>(`/admin/scheduling/imports/${importType}/upload`, {
        method: 'POST',
        body: form
      });
      setNotice(job.error_rows
        ? `预检完成：${job.error_rows} 行错误，请修正文件后重新上传`
        : `预检通过：${job.valid_rows} 行可以提交`);
      setImportFile(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入预检失败');
    } finally {
      setBusy('');
    }
  };

  const changeImport = async (id: string, action: 'commit' | 'rollback') => {
    setBusy(`import:${id}:${action}`);
    setError('');
    setNotice('');
    try {
      await api(`/admin/scheduling/imports/${id}/${action}`, { method: 'POST' });
      setNotice(action === 'commit' ? '导入已提交并写入本地数据库' : '导入已回滚');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入任务操作失败');
    } finally {
      setBusy('');
    }
  };

  const createRule = async () => {
    if (!ruleDraft.anchorId) {
      setError('请选择主播');
      return;
    }
    setBusy('availability:create');
    setError('');
    try {
      await api(`/admin/scheduling/anchors/${ruleDraft.anchorId}/availability-rules`, {
        method: 'POST',
        body: JSON.stringify(ruleDraft)
      });
      setNotice('每周可用性规则已保存，后续自动排班将立即使用');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '每周规则保存失败');
    } finally {
      setBusy('');
    }
  };

  const deleteRule = async (id: string) => {
    setBusy(`availability:${id}`);
    setError('');
    try {
      await api(`/admin/scheduling/availability-rules/${id}`, { method: 'DELETE' });
      setNotice('每周可用性规则已删除');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除规则失败');
    } finally {
      setBusy('');
    }
  };

  const toggleRoom = async (
    profile: AnchorProfile,
    room: RoomEligibility
  ) => {
    setBusy(`room:${profile.id}:${room.roomId}`);
    setError('');
    try {
      await api(
        `/admin/scheduling/anchors/${profile.id}/rooms/${room.roomId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            eligible: !room.eligible,
            priority: room.priority,
            reason: !room.eligible ? '管理员确认可排' : '管理员暂停该直播间资格'
          })
        }
      );
      setNotice(`${profile.display_name} 的直播间资格已更新`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '直播间资格更新失败');
    } finally {
      setBusy('');
    }
  };

  if (!configuration) {
    return (
      <AppShell>
        <main className="page operations-page">
          {error ? <AlertBanner tone="danger" title={error} /> : <LoadingState label="正在读取本地排班配置…" />}
        </main>
      </AppShell>
    );
  }

  const primary = configuration.dataSources.find((item) => item.is_primary);
  const rule = configuration.activeRuleSet;

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">LOCAL SCHEDULING CONTROL</p>
            <h1 className="title">自动排班配置</h1>
            <p className="muted">
              配置主播资格、直播间范围和月工时目标；所有数据保存在程序数据库中。
            </p>
          </div>
          <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void load()}>
            <RefreshCw className={busy ? 'spin' : undefined} size={17} aria-hidden />刷新
          </button>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {notice ? <AlertBanner tone="success" title={notice} /> : null}

        <section className="auto-plan-metrics">
          <article className="metric-card">
            <Database aria-hidden />
            <span>排班主数据</span>
            <strong>{primary?.name ?? '未配置'}</strong>
            <small>飞书运行依赖：无</small>
          </article>
          <article className="metric-card">
            <ShieldCheck aria-hidden />
            <span>规则版本</span>
            <strong>{rule ? `V${rule.version}` : '—'}</strong>
            <small>{rule?.name ?? '未配置活动规则'}</small>
          </article>
          <article className="metric-card">
            <CalendarRange aria-hidden />
            <span>覆盖模板</span>
            <strong>{configuration.coverageTemplates.length}</strong>
            <small>按直播间独立配置</small>
          </article>
          <article className="metric-card">
            <UsersRound aria-hidden />
            <span>主播档案</span>
            <strong>{configuration.profiles.length}</strong>
            <small>{configuration.availabilityExceptions.length} 条近期可用性例外</small>
          </article>
        </section>

        {rule ? (
          <section className="card auto-plan-generator">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">ACTIVE RULE SET</p>
                <h2>当前硬规则</h2>
              </div>
              <StatusBadge status="COMPLETED" label="生效中" />
            </div>
            <div className="auto-plan-rules-strip">
              <span><Gauge size={15} />单次 {rule.max_session_minutes / 60} 小时</span>
              <span><ShieldCheck size={15} />最短休息 {rule.min_rest_minutes / 60} 小时</span>
              <span>全职下限 {rule.full_time_min_monthly_minutes / 60}h</span>
              <span>目标 {rule.full_time_target_monthly_minutes / 60}h</span>
              <span>上限 {rule.full_time_max_monthly_minutes / 60}h</span>
            </div>
            <div className="panel-heading scheduling-strategy-heading">
              <div>
                <p className="eyebrow">BUSINESS FIRST STRATEGY</p>
                <h2>经营优先策略</h2>
                <p className="muted">兼职公平默认仅10%，不会再为了平均工时强行安排弱兼职。</p>
              </div>
              <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void saveStrategy()}>
                {busy === 'strategy' ? <RefreshCw className="spin" size={16} aria-hidden /> : <Save size={16} aria-hidden />}
                保存策略
              </button>
            </div>
            <div className="scheduling-profile-hours strategy-weight-grid">
              {([
                ['businessPriority', '经营优先'],
                ['abilityWeight', '能力权重'],
                ['fullTimePriority', '全职优先'],
                ['partTimeFairness', '兼职公平'],
                ['developmentRatio', '培养主播比例'],
                ['goldenTimeProtection', '黄金时间保护']
              ] as const).map(([key, label]) => (
                <label className="field compact-field" key={key}>{label}（0-100）
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={strategyDraft[key]}
                    onChange={(event) => setStrategyDraft((current) => ({
                      ...current,
                      [key]: Math.max(0, Math.min(100, Number(event.target.value)))
                    }))}
                  />
                </label>
              ))}
            </div>
            <p className="muted">评分结构固定为：能力40%＋直播间适配25%＋人员类型15%＋时段适配15%＋负载5%；以上配置用于控制经营倾向强度。</p>
          </section>
        ) : null}

        <section className="card admin-people-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ANCHOR ELIGIBILITY</p>
              <h2>主播排班资格与工时</h2>
            </div>
            <StatusBadge status="DRAFT" label={`${configuration.profiles.length} 人`} />
          </div>
          <div className="scheduling-profile-grid">
            {configuration.profiles.map((source) => {
              const profile = drafts[source.id] ?? source;
              return (
                <article className="scheduling-profile-card" key={source.id}>
                  <header>
                    <div>
                      <strong>{profile.display_name}</strong>
                      <small>{employmentLabel(profile.employment_type)} · {profile.employment_status}</small>
                    </div>
                    <label className="auto-plan-swap-choice">
                      <input
                        type="checkbox"
                        checked={profile.eligible_for_auto_schedule}
                        onChange={(event) => updateDraft(profile.id, { eligible_for_auto_schedule: event.target.checked })}
                      />
                      自动排班
                    </label>
                  </header>
                  <div className="scheduling-profile-hours">
                    <label className="field compact-field">下限（小时）
                      <input type="number" min={0} placeholder={profile.employment_type === 'FULL_TIME' ? '104' : '不设下限'} value={hoursValue(profile.min_monthly_minutes)} onChange={(event) => updateDraft(profile.id, { min_monthly_minutes: minutesValue(event.target.value) })} />
                    </label>
                    <label className="field compact-field">目标（小时）
                      <input type="number" min={0} placeholder={profile.employment_type === 'FULL_TIME' ? '117' : '按可用时间'} value={hoursValue(profile.target_monthly_minutes)} onChange={(event) => updateDraft(profile.id, { target_monthly_minutes: minutesValue(event.target.value) })} />
                    </label>
                    <label className="field compact-field">上限（小时）
                      <input type="number" min={0} placeholder={profile.employment_type === 'FULL_TIME' ? '130' : '按可用时间'} value={hoursValue(profile.max_monthly_minutes)} onChange={(event) => updateDraft(profile.id, { max_monthly_minutes: minutesValue(event.target.value) })} />
                    </label>
                  </div>
                  <div className="scheduling-profile-hours employment-dates">
                    <label className="field compact-field">入职日期
                      <input
                        type="date"
                        value={profile.employment_started_on?.slice(0, 10) ?? ''}
                        onChange={(event) => updateDraft(profile.id, { employment_started_on: event.target.value || null })}
                      />
                    </label>
                    <label className="field compact-field">离职日期
                      <input
                        type="date"
                        value={profile.employment_ended_on?.slice(0, 10) ?? ''}
                        onChange={(event) => updateDraft(profile.id, { employment_ended_on: event.target.value || null })}
                      />
                    </label>
                    <p className="muted">月中入职或离职时，系统按当月有效天数折算工时目标。</p>
                  </div>
                  <div className="scheduling-profile-rooms">
                    {profile.rooms.map((room) => (
                      <button
                        key={room.roomId}
                        className={`status ${room.eligible ? 'success' : ''}`}
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => void toggleRoom(profile, room)}
                      >
                        {room.eligible ? <BadgeCheck size={14} aria-hidden /> : null}
                        {room.roomName}
                      </button>
                    ))}
                  </div>
                  <footer>
                    <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void saveProfile(profile.id)}>
                      {busy === `profile:${profile.id}` ? <RefreshCw className="spin" size={16} aria-hidden /> : <Save size={16} aria-hidden />}
                      保存主播配置
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>

        <section className="card admin-people-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">WEEKLY AVAILABILITY</p>
              <h2>每周固定可用时段</h2>
              <p className="muted">用于长期固定休息、偏好或不可排时间；临时请假仍使用可用性例外。</p>
            </div>
            <StatusBadge status="DRAFT" label={`${configuration.availabilityRules.length} 条`} />
          </div>
          <div className="availability-rule-form">
            <label className="field">主播
              <select value={ruleDraft.anchorId} onChange={(event) => setRuleDraft((current) => ({ ...current, anchorId: event.target.value }))}>
                <option value="">请选择主播</option>
                {configuration.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
              </select>
            </label>
            <label className="field">星期
              <select value={ruleDraft.dayOfWeek} onChange={(event) => setRuleDraft((current) => ({ ...current, dayOfWeek: Number(event.target.value) }))}>
                {weekLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}
              </select>
            </label>
            <label className="field">开始时间
              <input type="time" value={minuteText(ruleDraft.startMinute)} onChange={(event) => {
                const [hour, minute] = event.target.value.split(':').map(Number);
                setRuleDraft((current) => ({ ...current, startMinute: (hour ?? 0) * 60 + (minute ?? 0) }));
              }} />
            </label>
            <label className="field">结束时间
              <input type="time" value={ruleDraft.endMinute === 1440 ? '23:59' : minuteText(ruleDraft.endMinute)} onChange={(event) => {
                const [hour, minute] = event.target.value.split(':').map(Number);
                setRuleDraft((current) => ({ ...current, endMinute: (hour ?? 0) * 60 + (minute ?? 0) }));
              }} />
            </label>
            <label className="field">规则
              <select value={ruleDraft.availabilityType} onChange={(event) => setRuleDraft((current) => ({ ...current, availabilityType: event.target.value }))}>
                <option value="AVAILABLE">可排</option>
                <option value="UNAVAILABLE">不可排</option>
                <option value="PREFERRED">优先</option>
                <option value="AVOID">尽量避开</option>
              </select>
            </label>
            <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void createRule()}>
              <Save size={16} aria-hidden />保存规则
            </button>
          </div>
          <div className="availability-rule-list">
            {configuration.availabilityRules.length ? configuration.availabilityRules.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.anchor_name}</strong>
                  <span>{weekLabels[item.day_of_week]} · {minuteText(item.start_minute)}—{minuteText(item.end_minute)}</span>
                </div>
                <StatusBadge status={item.availability_type} />
                <button className="icon-button" type="button" aria-label="删除规则" disabled={Boolean(busy)} onClick={() => void deleteRule(item.id)}>
                  <Trash2 size={16} aria-hidden />
                </button>
              </article>
            )) : <p className="muted">尚未配置固定规则，系统默认按资格与例外时间排班。</p>}
          </div>
        </section>

        <section className="card admin-people-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SAFE IMPORT CENTER</p>
              <h2>排班主数据导入</h2>
              <p className="muted">文件先预检，不会直接覆盖数据；预检通过后手工提交，完成后仍可回滚。</p>
            </div>
            <Import aria-hidden />
          </div>
          <div className="schedule-import-form">
            <label className="field">数据类型
              <select value={importType} onChange={(event) => setImportType(event.target.value)}>
                {Object.entries(importTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="field import-file-field">CSV / XLSX 文件
              <input type="file" accept=".csv,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} />
            </label>
            <button className="button" type="button" disabled={Boolean(busy) || !importFile} onClick={() => void uploadImport()}>
              {busy === 'import:upload' ? <RefreshCw className="spin" size={16} aria-hidden /> : <Import size={16} aria-hidden />}
              上传并预检
            </button>
          </div>
          <div className="schedule-import-jobs">
            {importJobs.length ? importJobs.map((job) => (
              <article key={job.id}>
                <div className="import-job-main">
                  <History size={17} aria-hidden />
                  <div>
                    <strong>{importTypeLabels[job.import_type] ?? job.import_type} · {job.source_file_name}</strong>
                    <small>共 {job.total_rows} 行，校验通过 {job.valid_rows} 行，错误 {job.error_rows} 行</small>
                  </div>
                </div>
                <StatusBadge status={job.status} />
                <div className="import-job-actions">
                  {job.status === 'READY' ? <button className="button small" type="button" disabled={Boolean(busy)} onClick={() => void changeImport(job.id, 'commit')}>确认导入</button> : null}
                  {job.status === 'COMPLETED' ? <button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => void changeImport(job.id, 'rollback')}>回滚</button> : null}
                </div>
              </article>
            )) : <p className="muted">暂无导入任务。</p>}
          </div>
        </section>
      </main>
    </AppShell>
  );
}
