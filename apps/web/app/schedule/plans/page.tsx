'use client';

import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Gauge,
  GitCompareArrows,
  Lock,
  Copy,
  CalendarPlus2,
  Redo2,
  Repeat2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Sparkles,
  UsersRound,
  Unlock,
  Undo2,
  WandSparkles,
  X
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { LoadingState } from '@/components/loading-state';
import { SectionTabs } from '@/components/section-tabs';
import { ApiError, api, formatDateTime, formatTime } from '@/lib/api';

interface RoomOption {
  id: string;
  name: string;
}

interface AnchorOption {
  id: string;
  display_name: string;
  employment_type: string;
}

interface PerformanceScore {
  id: string;
  anchor_id: string;
  room_id: string;
  capability_score: number;
  confidence_grade: 'A' | 'B' | 'C';
  sample_hours: number;
  period_start: string;
  period_end: string;
  source_rank: number;
  source_document: string;
  adjusted_roi_index?: number | null;
  adjusted_hourly_gmv_index?: number | null;
  evidence_status?: string | null;
  source_sha256?: string | null;
  anchor_name: string;
  room_name: string;
}

interface ScheduleRules {
  coverageStartHour: number;
  coverageEndHour: number;
  blockHours: number;
  maxSessionHours?: number;
  /** 兼容历史草案快照，语义同为单次连续直播上限。 */
  maxDailyHours: number;
  minRestHours: number;
  fullTimeMinMonthlyHours: number;
  fullTimeMaxMonthlyHours: number;
  morningStartHour: number;
  morningEndHour: number;
  overnightStartHour: number;
  overnightEndHour: number;
  strongScoreThreshold: number;
  weakScoreThreshold: number;
}

interface ScheduleOptions {
  rooms: RoomOption[];
  anchors: AnchorOption[];
  performanceScores: PerformanceScore[];
  defaults: ScheduleRules;
  evidenceNotice: string;
  dataSources?: Array<{
    id: string;
    code: string;
    name: string;
    source_type: string;
    is_primary: boolean;
    status: string;
  }>;
  coverageTemplates?: Array<{
    id: string;
    room_id: string;
    room_name: string;
    name: string;
    slots: unknown[];
  }>;
  automation?: {
    enabled?: boolean;
    dayOfMonth?: number | null;
    hour?: number | null;
    minute?: number | null;
    monthsAhead?: number | null;
    timezone?: string | null;
    draftOnly?: boolean | null;
    onlyCreatesDraft?: boolean | null;
  } | null;
}

interface AutomationFormState {
  enabled: boolean;
  dayOfMonth: number;
  hour: number;
  minute: number;
  monthsAhead: number;
}

type ExistingSchedulePolicy = 'PRESERVE_EXISTING' | 'REPLACE_AUTO_PLAN';
type ScheduleStrategy = 'BUSINESS' | 'BALANCED' | 'CALIBRATION';

interface SchedulePrecheck {
  feasible: boolean;
  month: string;
  strategy: ScheduleStrategy;
  dataAuthority: string;
  feishuRuntimeRequired: boolean;
  summary: {
    roomCount: number;
    daysInMonth: number;
    demandHours: number;
    eligibleAnchorCount: number;
    fullTimeAnchorCount: number;
    minimumRequiredHours: number;
    maximumCapacityHours: number;
    unavailableExceptionCount: number;
    crossBoundarySessionCount: number;
  };
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

interface PlanComparison {
  summary: { changed: number; added: number; removed: number; unchanged: number };
  changes: unknown[];
}

interface AnchorHoursView extends AnchorHours {
  generatedHours: number;
  existingHours: number;
  hours: number;
  fullTime: boolean;
  below: boolean;
  over: boolean;
  max: number;
  priority: number;
}

interface PlanSummary {
  id: string;
  schedule_month: string;
  status: string;
  version: number;
  generation_summary: Record<string, unknown>;
  validation_summary: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  published_at?: string | null;
  created_by_name?: string;
  slot_count: number;
  assignment_count: number;
  name?: string | null;
  strategy?: ScheduleStrategy;
}

interface PlanRecord {
  id: string;
  schedule_month: string;
  status: string;
  rules_snapshot: ScheduleRules;
  generation_summary: Record<string, unknown>;
  validation_summary: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  published_at?: string | null;
  name?: string | null;
  strategy?: ScheduleStrategy;
  cloned_from_plan_id?: string | null;
  supersedes_plan_id?: string | null;
}

interface PlanSlot {
  id: string;
  room_id: string;
  room_name: string;
  starts_at: string;
  ends_at: string;
  required_anchor_count: number;
  status: string;
  notes?: string | null;
  assignment_id?: string | null;
  anchor_id?: string | null;
  anchor_name?: string | null;
  employment_type?: string | null;
  preference_tier?: string | null;
  score?: number | null;
  reasons?: string[] | null;
  warnings?: string[] | null;
  assignment_version?: number | null;
  assignment_status?: string | null;
  published_session_id?: string | null;
  capability_score?: number | null;
  confidence_grade?: 'A' | 'B' | 'C' | null;
  sample_hours?: number | null;
  source_document?: string | null;
  adjusted_roi_index?: number | null;
  adjusted_hourly_gmv_index?: number | null;
  evidence_status?: string | null;
  locked?: boolean;
  locked_reason?: string | null;
  locked_at?: string | null;
  manual_override?: boolean;
  change_reason?: string | null;
}

interface PlanViolation {
  id: string;
  assignment_id?: string | null;
  anchor_id?: string | null;
  room_id?: string | null;
  rule_code: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  anchor_name?: string | null;
  room_name?: string | null;
}

interface AnchorHours {
  anchor_id: string;
  display_name: string;
  employment_type: string;
  generated_hours: number;
  existing_hours?: number;
  total_hours?: number;
}

interface PlanDetails {
  plan: PlanRecord;
  slots: PlanSlot[];
  violations: PlanViolation[];
  anchorHours: AnchorHours[];
  editHistory?: Array<{
    id: string;
    operation_type: string;
    status: 'APPLIED' | 'UNDONE';
    reason?: string | null;
    created_at: string;
    created_by_name?: string | null;
  }>;
  editCapabilities?: {
    canUndo: boolean;
    canRedo: boolean;
  };
  repairSummary?: {
    repairedCount: number;
    unresolvedAssignmentIds: string[];
  };
}

interface PlanListResponse {
  month: string;
  plans: PlanSummary[];
}

const statusLabels: Record<string, string> = {
  DRAFT: '待调整',
  GENERATING: '生成中',
  REVIEWING: '审核中',
  VALIDATED: '校验通过',
  PUBLISHED: '已发布',
  SUPERSEDED: '已被新版替代',
  ARCHIVED: '历史草案',
  FAILED: '生成失败'
};

const tierLabels: Record<string, string> = {
  STRONG: '高能力 / 早班软优先',
  WEAK: '培养期 / 凌晨软优先',
  NEUTRAL: '中性安排'
};

function currentMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit'
  }).format(new Date());
}

function shanghaiDate(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function formatSlotDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(value));
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorMessage(reason: unknown): string {
  return reason instanceof ApiError
    ? reason.message
    : reason instanceof Error
      ? reason.message
      : '操作失败，请稍后重试';
}

function sourceShortName(value?: string | null): string {
  if (!value) return '无能力档案';
  return value.replace(/\.docx$/i, '').replace(/^【柏瑞美】/, '');
}

function employmentLabel(value?: string | null): string {
  if (value === 'FULL_TIME') return '全职';
  if (value === 'PART_TIME') return '兼职';
  return '用工类型待确认';
}

function nextMonthValue(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return monthNumber === 12
    ? `${year! + 1}-01`
    : `${year}-${String(monthNumber! + 1).padStart(2, '0')}`;
}

function toShanghaiLocalInput(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function shanghaiInputToIso(value: string): string {
  return new Date(`${value}:00+08:00`).toISOString();
}

function automationDescription(
  automation: ScheduleOptions['automation']
): string {
  if (!automation?.enabled) return '自动生成未启用';
  const completeTiming = [
    automation.dayOfMonth,
    automation.hour,
    automation.minute,
    automation.monthsAhead
  ].every((value) => Number.isInteger(value));
  if (!completeTiming) return '自动生成已启用，执行时间配置待同步';

  const monthsAhead = Number(automation.monthsAhead);
  const targetMonth =
    monthsAhead === 0
      ? '当月'
      : monthsAhead === 1
        ? '下月'
        : `${monthsAhead}个月后`;
  const draftOnly = automation.draftOnly ?? automation.onlyCreatesDraft;
  const publishPolicy =
    draftOnly === true
      ? '，仅草案不自动发布'
      : draftOnly === false
        ? '，发布策略由后台配置'
        : '，发布策略待同步';
  return `每月${automation.dayOfMonth}日${String(automation.hour).padStart(2, '0')}:${String(automation.minute).padStart(2, '0')}自动生成${targetMonth}草案${publishPolicy}`;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function automationFormValue(
  automation: ScheduleOptions['automation']
): AutomationFormState {
  return {
    enabled: Boolean(automation?.enabled),
    dayOfMonth: boundedInteger(automation?.dayOfMonth, 1, 28, 20),
    hour: boundedInteger(automation?.hour, 0, 23, 10),
    minute: boundedInteger(automation?.minute, 0, 59, 0),
    monthsAhead: boundedInteger(automation?.monthsAhead, 1, 3, 1)
  };
}

export default function MonthlySchedulePlansPage() {
  const [month, setMonth] = useState(currentMonth());
  const [options, setOptions] = useState<ScheduleOptions | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [plan, setPlan] = useState<PlanDetails | null>(null);
  const [selectedRooms, setSelectedRooms] = useState<string[]>([]);
  const [coverageStartHour, setCoverageStartHour] = useState(0);
  const [coverageEndHour, setCoverageEndHour] = useState(24);
  const [blockHours, setBlockHours] = useState(4);
  const [existingSchedulePolicy, setExistingSchedulePolicy] =
    useState<ExistingSchedulePolicy>('PRESERVE_EXISTING');
  const [strategy, setStrategy] = useState<ScheduleStrategy>('BUSINESS');
  const [precheck, setPrecheck] = useState<SchedulePrecheck | null>(null);
  const [swapSelection, setSwapSelection] = useState<string[]>([]);
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const [batchAnchorId, setBatchAnchorId] = useState('');
  const [timeEdits, setTimeEdits] = useState<
    Record<string, { startsAt: string; endsAt: string; roomId: string }>
  >({});
  const [comparison, setComparison] = useState<PlanComparison | null>(null);
  const [softRiskReason, setSoftRiskReason] = useState('');
  const [dayFilter, setDayFilter] = useState('');
  const [roomFilter, setRoomFilter] = useState('');
  const [pendingAnchors, setPendingAnchors] = useState<Record<string, string>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [planLoading, setPlanLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [optionsReloadKey, setOptionsReloadKey] = useState(0);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [formalScheduleFromFeishu, setFormalScheduleFromFeishu] =
    useState(false);
  const [automationForm, setAutomationForm] = useState<AutomationFormState>(() =>
    automationFormValue(null)
  );
  const planRequestRef = useRef(0);

  const loadPlan = useCallback(async (id: string) => {
    const requestId = ++planRequestRef.current;
    setPlanLoading(true);
    setError('');
    try {
      const details = await api<PlanDetails>(`/schedule-plans/${id}`);
      if (requestId !== planRequestRef.current) return;
      setPlan(details);
      setPendingAnchors({});
      setSwapSelection([]);
      setBatchSelection([]);
      setTimeEdits({});
      setComparison(null);
    } catch (reason) {
      if (requestId === planRequestRef.current) {
        setPlan(null);
        setError(errorMessage(reason));
      }
    } finally {
      if (requestId === planRequestRef.current) setPlanLoading(false);
    }
  }, []);

  const loadPlanList = useCallback(
    async (targetMonth: string, preferredPlanId?: string) => {
      const requestId = ++planRequestRef.current;
      setPlanLoading(true);
      setError('');
      try {
        const result = await api<PlanListResponse>(
          `/schedule-plans?month=${encodeURIComponent(targetMonth)}`
        );
        if (requestId !== planRequestRef.current) return;
        setPlans(result.plans);
        const nextPlan = preferredPlanId
          ? result.plans.find((item) => item.id === preferredPlanId)
          : result.plans[0];
        if (!nextPlan) {
          setPlan(null);
          return;
        }
        const details = await api<PlanDetails>(`/schedule-plans/${nextPlan.id}`);
        if (requestId !== planRequestRef.current) return;
        setPlan(details);
        setPendingAnchors({});
      } catch (reason) {
        if (requestId !== planRequestRef.current) return;
        setPlans([]);
        setPlan(null);
        setError(errorMessage(reason));
      } finally {
        if (requestId === planRequestRef.current) setPlanLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    let active = true;
    void api<ScheduleOptions>('/schedule-plans/options')
      .then((result) => {
        if (!active) return;
        setOptions(result);
        setAutomationForm(automationFormValue(result.automation));
        setSelectedRooms(result.rooms.map((room) => room.id));
        setCoverageStartHour(numberValue(result.defaults.coverageStartHour, 0));
        setCoverageEndHour(numberValue(result.defaults.coverageEndHour, 24));
        setBlockHours(numberValue(result.defaults.blockHours, 4));
        setPlanLoading(true);
      })
      .catch((reason: unknown) => {
        if (active) {
          setOptions(null);
          setPlans([]);
          setPlan(null);
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [optionsReloadKey]);

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => api<{ dataAuthority: string }>('/schedules/source-status'))
      .then((source) => {
        if (active) {
          setFormalScheduleFromFeishu(
            source.dataAuthority === 'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS'
          );
        }
      })
      .catch(() => {
        // 旧环境没有数据权威接口时，仍保留原有草案能力。
      });
    return () => {
      active = false;
    };
  }, []);

  const optionsReady = Boolean(options);

  useEffect(() => {
    if (!optionsReady) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void loadPlanList(month).catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setPlanLoading(false);
        }
      });
    }, 0);
    return () => {
      active = false;
      planRequestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadPlanList, month, optionsReady]);

  const planDates = useMemo(
    () =>
      [...new Set((plan?.slots ?? []).map((slot) => shanghaiDate(slot.starts_at)))].sort(),
    [plan]
  );
  const effectiveDayFilter = planDates.includes(dayFilter)
    ? dayFilter
    : planDates[0] ?? '';

  const filteredSlots = useMemo(
    () =>
      (plan?.slots ?? []).filter(
        (slot) =>
          (!effectiveDayFilter || shanghaiDate(slot.starts_at) === effectiveDayFilter) &&
          (!roomFilter || slot.room_id === roomFilter)
      ),
    [effectiveDayFilter, plan, roomFilter]
  );

  const violationCounts = useMemo(() => {
    const values = { ERROR: 0, WARNING: 0, INFO: 0 };
    for (const violation of plan?.violations ?? []) {
      values[violation.severity] += 1;
    }
    return values;
  }, [plan]);

  const latestScores = useMemo(() => {
    const result = new Map<string, PerformanceScore>();
    for (const score of options?.performanceScores ?? []) {
      const key = `${score.room_id}:${score.anchor_id}`;
      const current = result.get(key);
      if (!current || score.period_end > current.period_end) result.set(key, score);
    }
    return result;
  }, [options]);

  const anchorHoursView = useMemo<AnchorHoursView[]>(() => {
    if (!plan) return [];
    const minimum = plan.plan.rules_snapshot.fullTimeMinMonthlyHours;
    const maximum = plan.plan.rules_snapshot.fullTimeMaxMonthlyHours;
    return plan.anchorHours
      .map((anchor) => {
        const generatedHours = numberValue(anchor.generated_hours);
        const existingHours = numberValue(anchor.existing_hours);
        const hours = numberValue(
          anchor.total_hours,
          generatedHours + existingHours
        );
        const fullTime = anchor.employment_type === 'FULL_TIME';
        const below = fullTime && hours < minimum;
        const over = fullTime && hours > maximum;
        return {
          ...anchor,
          generatedHours,
          existingHours,
          hours,
          fullTime,
          below,
          over,
          max: fullTime ? maximum : Math.max(hours, 1),
          priority: over ? 0 : below ? 1 : anchor.employment_type === 'UNKNOWN' ? 2 : 3
        };
      })
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.hours - right.hours ||
          left.display_name.localeCompare(right.display_name, 'zh-CN')
      );
  }, [plan]);

  const anchorHoursSummary = useMemo(
    () => ({
      total: anchorHoursView.length,
      below: anchorHoursView.filter((anchor) => anchor.below).length,
      over: anchorHoursView.filter((anchor) => anchor.over).length,
      healthy: anchorHoursView.filter(
        (anchor) => anchor.fullTime && !anchor.below && !anchor.over
      ).length
    }),
    [anchorHoursView]
  );

  const editable = plan
    ? ['DRAFT', 'VALIDATED'].includes(plan.plan.status)
    : false;
  const isMutating = Boolean(busyAction);
  const generation = plan?.plan.generation_summary;
  const planReplacesAutoPlan =
    generation?.existingSchedulePolicy === 'REPLACE_AUTO_PLAN';
  const totalSlots = numberValue(generation?.totalDemandSlots, plan?.slots.length ?? 0);
  const preservedExistingSlots = numberValue(generation?.preservedExistingSlots, 0);
  const assignedSlots = numberValue(
    generation?.assignedSlots,
    plan?.slots.filter((slot) => slot.assignment_id).length ?? 0
  );
  const unfilledSlots = plan
    ? plan.slots.filter((slot) => !slot.assignment_id).length
    : numberValue(generation?.unfilledSlots, 0);
  const validationCurrent = Boolean(
    plan &&
      (['VALIDATED', 'PUBLISHED'].includes(plan.plan.status) ||
        plan.violations.length > 0)
  );

  const retryData = () => {
    setError('');
    if (!options) {
      setLoading(true);
      setOptionsReloadKey((value) => value + 1);
      return;
    }
    if (plan) {
      void loadPlan(plan.plan.id);
      return;
    }
    void loadPlanList(month);
  };

  const toggleRoom = (roomId: string) => {
    setSelectedRooms((current) =>
      current.includes(roomId)
        ? current.filter((id) => id !== roomId)
        : [...current, roomId]
    );
  };

  const saveAutomation = async () => {
    const valid =
      Number.isInteger(automationForm.dayOfMonth) &&
      automationForm.dayOfMonth >= 1 &&
      automationForm.dayOfMonth <= 28 &&
      Number.isInteger(automationForm.hour) &&
      automationForm.hour >= 0 &&
      automationForm.hour <= 23 &&
      Number.isInteger(automationForm.minute) &&
      automationForm.minute >= 0 &&
      automationForm.minute <= 59 &&
      Number.isInteger(automationForm.monthsAhead) &&
      automationForm.monthsAhead >= 1 &&
      automationForm.monthsAhead <= 3;
    if (!valid) {
      setError('自动生成时间无效，请检查日期、时、分和提前月份');
      return;
    }

    setBusyAction('automation');
    setError('');
    setNotice('');
    try {
      await api<ScheduleOptions['automation']>('/schedule-plans/automation', {
        method: 'PATCH',
        body: JSON.stringify(automationForm)
      });

      try {
        const refreshed = await api<ScheduleOptions>('/schedule-plans/options');
        setOptions(refreshed);
        setAutomationForm(automationFormValue(refreshed.automation));
        setAutomationOpen(false);
        setNotice('自动生成设置已保存；系统只会按时生成草案，不会自动发布。');
      } catch (reason) {
        setNotice('自动生成设置已保存。');
        setError(`设置已保存，但刷新当前状态失败：${errorMessage(reason)}`);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const generationRequest = () => ({
    month,
    roomIds: selectedRooms,
    coverageStartHour,
    coverageEndHour,
    blockHours,
    existingSchedulePolicy,
    strategy
  });

  const runPrecheck = async (): Promise<SchedulePrecheck | null> => {
    if (!selectedRooms.length) {
      setError('请至少选择一个直播间');
      return null;
    }
    if (coverageEndHour <= coverageStartHour) {
      setError('覆盖结束时间必须晚于开始时间');
      return null;
    }
    setBusyAction('precheck');
    setError('');
    setNotice('');
    try {
      const result = await api<SchedulePrecheck>('/schedule-plans/precheck', {
        method: 'POST',
        body: JSON.stringify(generationRequest())
      });
      setPrecheck(result);
      setNotice(
        result.feasible
          ? '生成前检查通过：主播容量、直播间资格和跨月边界已完成检查。'
          : `生成前检查发现 ${result.blockers.length} 个阻断项，请先处理。`
      );
      return result;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setBusyAction('');
    }
  };

  const generate = async () => {
    const checked = await runPrecheck();
    if (!checked?.feasible) return;
    setBusyAction('generate');
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>('/schedule-plans/generate', {
        method: 'POST',
        body: JSON.stringify(generationRequest())
      });
      setPlan(details);
      setNotice(
        existingSchedulePolicy === 'REPLACE_AUTO_PLAN'
          ? '月度修订草案已生成；旧自动排班仍保持生效，发布新草案时才会替换，人工排班始终保留。'
          : '月度排班草案已生成；原有人工和已发布排班均已保留。'
      );
      await loadPlanList(month, details.plan.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const changeAssignment = async (slot: PlanSlot) => {
    if (
      !plan ||
      !slot.assignment_id ||
      slot.assignment_version == null
    ) return;
    const anchorId = pendingAnchors[slot.assignment_id] ?? slot.anchor_id ?? '';
    if (!anchorId || anchorId === slot.anchor_id) return;
    setBusyAction(`assignment:${slot.assignment_id}`);
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/assignments/${slot.assignment_id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            anchorId,
            version: slot.assignment_version
          })
        }
      );
      setPlan(details);
      setPendingAnchors((current) => {
        const next = { ...current };
        delete next[slot.assignment_id!];
        return next;
      });
      setNotice('主播已调整。草案已回到待校验状态。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const toggleAssignmentLock = async (slot: PlanSlot) => {
    if (!plan || !slot.assignment_id || slot.assignment_version == null) return;
    setBusyAction(`lock:${slot.assignment_id}`);
    setError('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/assignments/${slot.assignment_id}/lock`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            locked: !slot.locked,
            version: slot.assignment_version,
            reason: slot.locked ? undefined : '人工确认保留该时段'
          })
        }
      );
      setPlan(details);
      setNotice(slot.locked ? '时段已解锁。' : '时段已锁定，后续调整不会误改该时段。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const swapAssignments = async () => {
    if (!plan || swapSelection.length !== 2) return;
    const [firstId, secondId] = swapSelection;
    const first = plan.slots.find((item) => item.assignment_id === firstId);
    const second = plan.slots.find((item) => item.assignment_id === secondId);
    if (
      !first?.assignment_version ||
      !second?.assignment_version ||
      !first.assignment_id ||
      !second.assignment_id
    ) return;
    setBusyAction('swap');
    setError('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/swap`,
        {
          method: 'POST',
          body: JSON.stringify({
            firstAssignmentId: first.assignment_id,
            secondAssignmentId: second.assignment_id,
            firstVersion: first.assignment_version,
            secondVersion: second.assignment_version,
            reason: '排班员在草案中交换主播'
          })
        }
      );
      setPlan(details);
      setSwapSelection([]);
      setNotice('两个时段的主播已交换，发布前请重新校验。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const moveResizeAssignment = async (slot: PlanSlot) => {
    if (!plan || !slot.assignment_id || slot.assignment_version == null) return;
    const edit = timeEdits[slot.assignment_id] ?? {
      startsAt: toShanghaiLocalInput(slot.starts_at),
      endsAt: toShanghaiLocalInput(slot.ends_at),
      roomId: slot.room_id
    };
    setBusyAction(`time:${slot.assignment_id}`);
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/assignments/${slot.assignment_id}/time`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            startsAt: shanghaiInputToIso(edit.startsAt),
            endsAt: shanghaiInputToIso(edit.endsAt),
            roomId: edit.roomId,
            version: slot.assignment_version,
            reason: '排班员精确调整时间或直播间'
          })
        }
      );
      setPlan(details);
      setTimeEdits((current) => {
        const next = { ...current };
        delete next[slot.assignment_id!];
        return next;
      });
      setNotice('时间与直播间已调整，硬约束已在后端重新检查。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const batchUpdateAssignments = async () => {
    if (!plan || !batchSelection.length || !batchAnchorId) return;
    setBusyAction('batch');
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/assignments-batch`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            assignmentIds: batchSelection,
            anchorId: batchAnchorId,
            reason: '排班员批量调整主播'
          })
        }
      );
      setPlan(details);
      setBatchSelection([]);
      setBatchAnchorId('');
      setNotice(`已批量调整 ${batchSelection.length} 个时段。`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const undoRedo = async (direction: 'undo' | 'redo') => {
    if (!plan) return;
    setBusyAction(direction);
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/${direction}`,
        { method: 'POST' }
      );
      setPlan(details);
      setSwapSelection([]);
      setBatchSelection([]);
      setNotice(direction === 'undo' ? '已撤销上一步排班编辑。' : '已重做排班编辑。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const autoRepair = async () => {
    if (!plan) return;
    setBusyAction('repair');
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/auto-repair`,
        {
          method: 'POST',
          body: JSON.stringify({
            assignmentIds: batchSelection.length ? batchSelection : undefined,
            reason: batchSelection.length
              ? '自动修复选中未锁定时段'
              : '自动修复当前冲突或未锁定时段'
          })
        }
      );
      setPlan(details);
      setBatchSelection([]);
      const repaired = details.repairSummary?.repairedCount ?? 0;
      const unresolved = details.repairSummary?.unresolvedAssignmentIds.length ?? 0;
      setNotice(`自动修复完成：调整 ${repaired} 个时段，仍有 ${unresolved} 个时段需人工处理。`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const copyToNextMonth = async () => {
    if (!plan) return;
    const targetMonth = nextMonthValue(plan.plan.schedule_month.slice(0, 7));
    setBusyAction('copy-month');
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/copy-to-month`,
        {
          method: 'POST',
          body: JSON.stringify({
            targetMonth,
            name: `${targetMonth} 主播排班草案（复制上月）`
          })
        }
      );
      setMonth(targetMonth);
      setPlan(details);
      setNotice(`已复制到 ${targetMonth}，超出目标月份的日期已自动跳过。`);
      await loadPlanList(targetMonth, details.plan.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const cloneCurrentPlan = async (rollback = false) => {
    if (!plan) return;
    setBusyAction(rollback ? 'rollback' : 'clone');
    setError('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/${rollback ? 'rollback' : 'clone'}`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: `${plan.plan.schedule_month.slice(0, 7)} ${rollback ? '回滚' : '修订'}草案`
          })
        }
      );
      setPlan(details);
      setNotice(
        rollback
          ? '已从所选版本创建安全回滚草案；正式排班尚未改变。'
          : '已创建独立修订草案，原版本保持不变。'
      );
      await loadPlanList(month, details.plan.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const compareWithPrevious = async () => {
    if (!plan) return;
    const currentIndex = plans.findIndex((item) => item.id === plan.plan.id);
    const previous = plans[currentIndex + 1] ?? plans.find((item) => item.id !== plan.plan.id);
    if (!previous) {
      setError('本月还没有其他版本可比较');
      return;
    }
    setBusyAction('compare');
    setError('');
    try {
      const result = await api<PlanComparison>(
        `/schedule-plans/compare?leftId=${encodeURIComponent(previous.id)}&rightId=${encodeURIComponent(plan.plan.id)}`
      );
      setComparison(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const validate = async () => {
    if (!plan) return;
    setBusyAction('validate');
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/validate`,
        { method: 'POST' }
      );
      setPlan(details);
      const errors = details.violations.filter(
        (item) => item.severity === 'ERROR'
      ).length;
      setNotice(
        errors
          ? `校验完成，仍有 ${errors} 个硬约束问题。`
          : '硬约束校验通过，可以发布正式排班。'
      );
      await loadPlanList(month, details.plan.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  const publish = async () => {
    if (!plan) return;
    setBusyAction('publish');
    setError('');
    setNotice('');
    try {
      const details = await api<PlanDetails>(
        `/schedule-plans/${plan.plan.id}/publish`,
        {
          method: 'POST',
          body: JSON.stringify({
            softRiskReason: softRiskReason.trim() || undefined
          })
        }
      );
      setPlan(details);
      setPublishConfirm(false);
      setSoftRiskReason('');
      setNotice('月度排班已发布，并写入正式直播场次。');
      await loadPlanList(month, details.plan.id);
    } catch (reason) {
      setPublishConfirm(false);
      setError(errorMessage(reason));
    } finally {
      setBusyAction('');
    }
  };

  if (loading) {
    return (
      <AppShell>
        <main className="page auto-plan-page">
          <LoadingState label="正在读取主播、直播间和能力档案…" />
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <main className="page auto-plan-page">
        <header className="business-page-header auto-plan-header">
          <div>
            <Link className="auto-plan-back" href="/schedule">
              <ArrowLeft size={16} aria-hidden /> 返回排班中心
            </Link>
            <p className="eyebrow">MONTHLY AUTO SCHEDULING</p>
            <h1 className="title">月度辅助排班方案</h1>
            <p className="muted">
              用于测算工时、发现缺口和辅助人工排班；正式排班仍以飞书表格为准。
            </p>
          </div>
          {plan ? (
            <div className="auto-plan-current-state">
              <span className={`status auto-plan-status-${plan.plan.status.toLowerCase()}`}>
                {statusLabels[plan.plan.status] ?? plan.plan.status}
              </span>
              <small>更新于 {formatDateTime(plan.plan.updated_at)}</small>
            </div>
          ) : null}
        </header>
        <SectionTabs
          label="排班管理模块"
          activeHref="/schedule/plans"
          items={[
            { href: '/schedule/plans', label: '月度辅助方案', description: '仅供测算和人工参考' },
            { href: '/schedule', label: '飞书正式排班', description: '同步直播、人员与妆造日程' },
            { href: '/admin/scheduling', label: '排班资源', description: '资格、范围与能力依据' }
          ]}
        />

        {error ? (
          <div className="alert-banner danger auto-plan-feedback" role="alert">
            <AlertTriangle size={18} aria-hidden />
            <div>
              <strong>操作未完成</strong>
              <span>{error}</span>
            </div>
            <div className="auto-plan-feedback-actions">
              <button className="button secondary" type="button" onClick={retryData}>
                <RefreshCw size={15} aria-hidden />
                刷新数据
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭错误提示"
                onClick={() => setError('')}
              >
                <X size={17} aria-hidden />
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className="alert-banner success auto-plan-feedback" role="status">
            <CheckCircle2 size={18} aria-hidden />
            <div>
              <strong>{notice}</strong>
              <span>所有人工调整、校验和发布动作均会保留操作记录。</span>
            </div>
          </div>
        ) : null}

        {options?.evidenceNotice ? (
          <div className="alert-banner auto-plan-evidence">
            <ShieldAlert size={18} aria-hidden />
            <div>
              <strong>能力数据使用边界</strong>
              <span>{options.evidenceNotice}</span>
            </div>
          </div>
        ) : null}

        {formalScheduleFromFeishu ? (
          <div className="alert-banner info auto-plan-feedback" role="status">
            <ShieldAlert size={18} aria-hidden />
            <div>
              <strong>当前为飞书正式排班模式</strong>
              <span>
                本页草案不会发布或覆盖正式排班；确认方案后，请在飞书表格调整并回到正式排班页同步。
              </span>
            </div>
          </div>
        ) : null}

        <section id="schedule-generator" className="card auto-plan-generator">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DRAFT GENERATOR</p>
              <h2>生成月度草案</h2>
            </div>
            <span className="auto-plan-safe-note">生成草案不会立即覆盖正式排班</span>
          </div>
          <div className={`auto-plan-automation-panel${options?.automation?.enabled ? ' is-enabled' : ''}`}>
            <div className="auto-plan-automation">
              <CalendarRange size={18} aria-hidden />
              <div className="auto-plan-automation-copy">
                <strong>自动生成</strong>
                <span>{automationDescription(options?.automation)}</span>
                {options?.automation?.enabled && options.automation.timezone ? (
                  <small>时区：{options.automation.timezone}</small>
                ) : null}
              </div>
              <div className="auto-plan-automation-actions">
                <span className={options?.automation?.enabled ? 'status success' : 'status'}>
                  {options?.automation?.enabled ? '已启用' : '未启用'}
                </span>
                <button
                  className="button secondary auto-plan-automation-toggle-button"
                  type="button"
                  aria-expanded={automationOpen}
                  disabled={isMutating}
                  onClick={() => {
                    setAutomationOpen((current) => !current);
                    setError('');
                  }}
                >
                  {automationOpen ? '收起自动设置' : '设置自动生成'}
                </button>
              </div>
            </div>
            {automationOpen ? (
              <form
                className="auto-plan-automation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAutomation();
                }}
              >
                <label className="auto-plan-automation-switch">
                  <input
                    type="checkbox"
                    checked={automationForm.enabled}
                    disabled={isMutating}
                    onChange={(event) =>
                      setAutomationForm((current) => ({
                        ...current,
                        enabled: event.target.checked
                      }))
                    }
                  />
                  <span>
                    <strong>启用每月自动生成</strong>
                    <small>关闭后仍可手工生成草案</small>
                  </span>
                </label>
                <label className="field">
                  每月日期
                  <select
                    value={automationForm.dayOfMonth}
                    disabled={isMutating}
                    onChange={(event) =>
                      setAutomationForm((current) => ({
                        ...current,
                        dayOfMonth: Number(event.target.value)
                      }))
                    }
                  >
                    {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>{day} 日</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  执行小时
                  <select
                    value={automationForm.hour}
                    disabled={isMutating}
                    onChange={(event) =>
                      setAutomationForm((current) => ({
                        ...current,
                        hour: Number(event.target.value)
                      }))
                    }
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, '0')} 时
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  执行分钟
                  <input
                    type="number"
                    min={0}
                    max={59}
                    step={1}
                    value={automationForm.minute}
                    disabled={isMutating}
                    onChange={(event) =>
                      setAutomationForm((current) => ({
                        ...current,
                        minute: Number(event.target.value)
                      }))
                    }
                  />
                </label>
                <label className="field">
                  生成目标
                  <select
                    value={automationForm.monthsAhead}
                    disabled={isMutating}
                    onChange={(event) =>
                      setAutomationForm((current) => ({
                        ...current,
                        monthsAhead: Number(event.target.value)
                      }))
                    }
                  >
                    <option value={1}>下月</option>
                    <option value={2}>2 个月后</option>
                    <option value={3}>3 个月后</option>
                  </select>
                </label>
                <div className="auto-plan-automation-form-footer">
                  <p>
                    自动任务只创建可修改草案，不会自动校验、自动发布，也不会覆盖飞书正式排班。
                  </p>
                  <button className="button" type="submit" disabled={isMutating}>
                    {busyAction === 'automation' ? (
                      <RefreshCw className="spin" size={16} aria-hidden />
                    ) : (
                      <CalendarRange size={16} aria-hidden />
                    )}
                    {busyAction === 'automation' ? '保存中' : '保存自动生成设置'}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
          <div className="alert-banner success auto-plan-evidence">
            <BadgeCheck size={18} aria-hidden />
            <div>
              <strong>正式排班主数据：飞书多维表格</strong>
              <span>
                本页只负责辅助测算和草案调整；正式生效需在飞书修改后同步到排班中心。
              </span>
            </div>
          </div>
          <div className="auto-plan-generator-grid">
            <label className="field">
              排班月份
              <input
                type="month"
                value={month}
                disabled={isMutating}
                onChange={(event) => {
                  planRequestRef.current += 1;
                  setMonth(event.target.value);
                  setPlans([]);
                  setPlan(null);
                  setPlanLoading(true);
                  setDayFilter('');
                  setRoomFilter('');
                  setPublishConfirm(false);
                  setNotice('');
                  setError('');
                }}
              />
            </label>
            <label className="field">
              排班策略
              <select
                value={strategy}
                disabled={isMutating}
                onChange={(event) => {
                  setStrategy(event.target.value as ScheduleStrategy);
                  setPrecheck(null);
                }}
              >
                <option value="BUSINESS">经营优先（推荐）</option>
                <option value="BALANCED">均衡优先</option>
                <option value="CALIBRATION">试岗校准</option>
              </select>
            </label>
            <label className="field">
              每段直播时长
              <select
                value={blockHours}
                disabled={isMutating}
                onChange={(event) => setBlockHours(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5].map((hour) => (
                  <option key={hour} value={hour}>
                    {hour} 小时{hour === 4 ? '（推荐）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              每日覆盖开始
              <select
                value={coverageStartHour}
                disabled={isMutating}
                onChange={(event) => setCoverageStartHour(Number(event.target.value))}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              每日覆盖结束
              <select
                value={coverageEndHour}
                disabled={isMutating}
                onChange={(event) => setCoverageEndHour(Number(event.target.value))}
              >
                {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
          </div>
          {blockHours === 3 ? (
            <div className="auto-plan-block-hours-note" role="status">
              <Clock3 size={17} aria-hidden />
              <div>
                <strong>3小时时段模式已启用</strong>
                <span>
                  新草案会按3小时拆分；生成后可在下方草案分配区逐时段查看和更换主播。
                </span>
              </div>
              <a href="#draft-assignment">
                {plan ? '查看草案分配' : '草案分配区在下方'}
              </a>
            </div>
          ) : null}
          <fieldset className="auto-plan-policy-picker">
            <legend>已有排班处理策略</legend>
            <div>
              <label className="auto-plan-policy-option">
                <input
                  type="radio"
                  name="existingSchedulePolicy"
                  value="PRESERVE_EXISTING"
                  checked={existingSchedulePolicy === 'PRESERVE_EXISTING'}
                  disabled={isMutating}
                  onChange={() => setExistingSchedulePolicy('PRESERVE_EXISTING')}
                />
                <span>
                  <strong>保留已有排班（默认）</strong>
                  <small>在现有人工和已发布排班周围补齐空缺。</small>
                </span>
              </label>
              <label className="auto-plan-policy-option">
                <input
                  type="radio"
                  name="existingSchedulePolicy"
                  value="REPLACE_AUTO_PLAN"
                  checked={existingSchedulePolicy === 'REPLACE_AUTO_PLAN'}
                  disabled={isMutating}
                  onChange={() => setExistingSchedulePolicy('REPLACE_AUTO_PLAN')}
                />
                <span>
                  <strong>替换系统自动排班</strong>
                  <small>生成修订草案时忽略本月旧自动排班；发布后才替换旧自动排班，人工排班始终保留。</small>
                </span>
              </label>
            </div>
          </fieldset>
          <fieldset className="auto-plan-room-picker">
            <legend>参与排班的直播间</legend>
            <div>
              {options?.rooms.map((room) => (
                <label key={room.id} className="auto-plan-room-option">
                  <input
                    type="checkbox"
                    checked={selectedRooms.includes(room.id)}
                    disabled={isMutating}
                    onChange={() => toggleRoom(room.id)}
                  />
                  <span>{room.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="auto-plan-rules-strip">
            <span><Clock3 size={15} />单次不超过 5 小时</span>
            <span><ShieldAlert size={15} />跨日间隔至少 8 小时</span>
            <span><Gauge size={15} />全职 104 下限 / 117 目标 / 130 上限</span>
            <span><Sparkles size={15} />A/B 能力分参与时段软排序</span>
          </div>
          {precheck ? (
            <div className={`alert-banner ${precheck.feasible ? 'success' : 'danger'}`}>
              {precheck.feasible ? <BadgeCheck size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}
              <div>
                <strong>{precheck.feasible ? '生成前检查通过' : '生成前检查未通过'}</strong>
                <span>
                  需求 {precheck.summary.demandHours.toFixed(1)}h · 可排主播 {precheck.summary.eligibleAnchorCount} 人 ·
                  剩余最大容量 {precheck.summary.maximumCapacityHours.toFixed(1)}h · 跨月边界排班 {precheck.summary.crossBoundarySessionCount} 条
                </span>
                {[...precheck.blockers, ...precheck.warnings].slice(0, 4).map((item) => (
                  <small key={`${item.code}:${item.message}`}>{item.message}</small>
                ))}
              </div>
            </div>
          ) : null}
          <footer className="auto-plan-generator-actions">
            <p>
              生成草案时不会删除或修改已发布场次；如覆盖不足，会保留缺口供处理。
            </p>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={isMutating || !options?.rooms.length}
                onClick={() => void runPrecheck()}
              >
                {busyAction === 'precheck' ? <RefreshCw className="spin" size={17} aria-hidden /> : <ShieldAlert size={17} aria-hidden />}
                生成前检查
              </button>
              <button
                className="button"
                type="button"
                disabled={isMutating || !options?.rooms.length}
                onClick={() => void generate()}
              >
                {busyAction === 'generate' ? (
                  <RefreshCw className="spin" size={17} aria-hidden />
                ) : (
                  <Sparkles size={17} aria-hidden />
                )}
                {plan ? '重新生成草案' : '一键生成草案'}
              </button>
            </div>
          </footer>
        </section>

        {plans.length ? (
          <section className="card auto-plan-history-bar">
            <label className="field compact-field">
              本月草案记录
              <select
                value={plan?.plan.id ?? plans[0]?.id ?? ''}
                disabled={planLoading || isMutating}
                onChange={(event) => void loadPlan(event.target.value)}
              >
                {plans.map((item) => (
                  <option key={item.id} value={item.id}>
                    {statusLabels[item.status] ?? item.status} · {formatDateTime(item.created_at)} · {item.assignment_count}/{item.slot_count} 时段
                  </option>
                ))}
              </select>
            </label>
            <div>
              <button className="button secondary" type="button" disabled={!plan || isMutating} onClick={() => void compareWithPrevious()}>
                <GitCompareArrows size={16} aria-hidden />版本比较
              </button>
              <button className="button secondary" type="button" disabled={!plan || isMutating} onClick={() => void cloneCurrentPlan(false)}>
                <Copy size={16} aria-hidden />克隆修订
              </button>
              <button className="button secondary" type="button" disabled={!plan || isMutating} onClick={() => void copyToNextMonth()}>
                <CalendarPlus2 size={16} aria-hidden />复制到下月
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={!plan?.editCapabilities?.canUndo || isMutating}
                onClick={() => void undoRedo('undo')}
              >
                <Undo2 size={16} aria-hidden />撤销
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={!plan?.editCapabilities?.canRedo || isMutating}
                onClick={() => void undoRedo('redo')}
              >
                <Redo2 size={16} aria-hidden />重做
              </button>
              {plan?.plan.status === 'PUBLISHED' ? (
                <button className="button secondary" type="button" disabled={isMutating} onClick={() => void cloneCurrentPlan(true)}>
                  <Repeat2 size={16} aria-hidden />创建回滚草案
                </button>
              ) : null}
            </div>
            <small>任何回滚都会先创建新草案，正式排班不会被直接删除。</small>
            {comparison ? (
              <span className="status">
                对比：变更 {comparison.summary.changed} · 新增 {comparison.summary.added} · 移除 {comparison.summary.removed} · 未变 {comparison.summary.unchanged}
              </span>
            ) : null}
          </section>
        ) : null}

        {planLoading ? (
          <section className="card auto-plan-loading">
            <LoadingState label="正在载入排班草案…" />
          </section>
        ) : null}

        {!planLoading && !plan ? (
          <section id="draft-assignment" className="card empty auto-plan-empty">
            <CalendarRange size={34} aria-hidden />
            <p className="eyebrow">DRAFT ASSIGNMENT</p>
            <h2>草案分配区</h2>
            <p className="muted">
              {month} 暂无自动排班草案。当前选择每段 {blockHours} 小时，生成后可在这里逐时段调整主播。
            </p>
          </section>
        ) : null}

        {!planLoading && plan ? (
          <>
            <section className="auto-plan-metrics" aria-label="草案概况">
              <article className="metric-card">
                <span>需求时段</span>
                <strong>{totalSlots}</strong>
                <small>{planDates.length} 个排班日</small>
              </article>
              <article className="metric-card">
                <span>已安排</span>
                <strong>{assignedSlots}</strong>
                <small>覆盖率 {totalSlots ? Math.round((assignedSlots / totalSlots) * 100) : 0}%</small>
              </article>
              <article className={`metric-card${unfilledSlots ? ' has-danger' : ''}`}>
                <span>覆盖缺口</span>
                <strong>{unfilledSlots}</strong>
                <small>{unfilledSlots ? '需补人员班次后重新生成' : '直播时段已覆盖'}</small>
              </article>
              <article className={`metric-card${validationCurrent && violationCounts.ERROR ? ' has-danger' : ''}`}>
                <span>硬约束校验</span>
                <strong>{validationCurrent ? violationCounts.ERROR : '—'}</strong>
                <small>
                  {validationCurrent
                    ? `${violationCounts.WARNING} 条提醒`
                    : '当前草案尚未校验'}
                </small>
              </article>
            </section>

            <div className="auto-plan-workspace">
              <section id="draft-assignment" className="card auto-plan-schedule-panel">
                <div className="panel-heading auto-plan-board-heading">
                  <div>
                    <p className="eyebrow">EDITABLE DRAFT</p>
                    <h2>逐时段调整主播</h2>
                  </div>
                  <div className="auto-plan-filters">
                    <label className="field compact-field">
                      日期
                      <input
                        type="date"
                        min={planDates[0]}
                        max={planDates.at(-1)}
                        value={effectiveDayFilter}
                        onChange={(event) => setDayFilter(event.target.value)}
                      />
                    </label>
                    <label className="field compact-field">
                      直播间
                      <select
                        value={roomFilter}
                        onChange={(event) => setRoomFilter(event.target.value)}
                      >
                        <option value="">全部直播间</option>
                        {options?.rooms.map((room) => (
                          <option key={room.id} value={room.id}>{room.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <div className="auto-plan-day-summary">
                  <strong>{effectiveDayFilter ? formatSlotDate(`${effectiveDayFilter}T00:00:00+08:00`) : '全部日期'}</strong>
                  <span>{filteredSlots.length} 个时段</span>
                  {swapSelection.length ? <span>已选择 {swapSelection.length}/2 个换班时段</span> : null}
                  {swapSelection.length === 2 ? (
                    <button className="button secondary" type="button" disabled={isMutating} onClick={() => void swapAssignments()}>
                      <Repeat2 size={15} aria-hidden />交换主播
                    </button>
                  ) : null}
                  {batchSelection.length ? (
                    <>
                      <span>批量选中 {batchSelection.length} 个时段</span>
                      <select
                        aria-label="批量更换主播"
                        value={batchAnchorId}
                        disabled={!editable || isMutating}
                        onChange={(event) => setBatchAnchorId(event.target.value)}
                      >
                        <option value="">选择目标主播</option>
                        {options?.anchors.map((anchor) => (
                          <option key={anchor.id} value={anchor.id}>
                            {anchor.display_name} · {employmentLabel(anchor.employment_type)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={!batchAnchorId || isMutating}
                        onClick={() => void batchUpdateAssignments()}
                      >
                        批量换人
                      </button>
                    </>
                  ) : null}
                  <button
                    className="button secondary"
                    type="button"
                    disabled={!editable || isMutating}
                    onClick={() => void autoRepair()}
                  >
                    <WandSparkles size={15} aria-hidden />
                    {batchSelection.length ? '修复选中' : '自动修复'}
                  </button>
                  {!editable ? <span>当前版本不可编辑</span> : null}
                </div>
                {filteredSlots.length ? (
                  <div className="table-wrap auto-plan-table-wrap">
                    <table className="auto-plan-table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>直播间</th>
                          <th>当前主播</th>
                          <th>能力依据</th>
                          <th>安排说明</th>
                          <th>调整</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSlots.map((slot) => {
                          const selectedAnchor = slot.assignment_id
                            ? pendingAnchors[slot.assignment_id] ?? slot.anchor_id ?? ''
                            : '';
                          const score = selectedAnchor
                            ? latestScores.get(`${slot.room_id}:${selectedAnchor}`)
                            : undefined;
                          const changed = Boolean(
                            slot.assignment_id && selectedAnchor !== slot.anchor_id
                          );
                          const timeEdit = slot.assignment_id
                            ? timeEdits[slot.assignment_id] ?? {
                                startsAt: toShanghaiLocalInput(slot.starts_at),
                                endsAt: toShanghaiLocalInput(slot.ends_at),
                                roomId: slot.room_id
                              }
                            : null;
                          const timeChanged = Boolean(
                            timeEdit &&
                              (timeEdit.startsAt !== toShanghaiLocalInput(slot.starts_at) ||
                                timeEdit.endsAt !== toShanghaiLocalInput(slot.ends_at) ||
                                timeEdit.roomId !== slot.room_id)
                          );
                          return (
                            <tr key={`${slot.id}:${slot.assignment_id ?? 'gap'}`} className={!slot.assignment_id ? 'is-gap' : undefined}>
                              <td data-label="时间">
                                <strong className="time-range">{formatTime(slot.starts_at)}–{formatTime(slot.ends_at)}</strong>
                              </td>
                              <td data-label="直播间"><strong>{slot.room_name}</strong></td>
                              <td data-label="当前主播">
                                {slot.assignment_id ? (
                                  <div className="auto-plan-anchor-cell">
                                    <span className="person-avatar" aria-hidden>{slot.anchor_name?.slice(0, 1)}</span>
                                    <span>
                                      <strong>{slot.anchor_name}</strong>
                                      <small>{employmentLabel(slot.employment_type)}</small>
                                    </span>
                                  </div>
                                ) : (
                                  <span className="status danger">未排到主播</span>
                                )}
                              </td>
                              <td data-label="能力依据">
                                {slot.capability_score != null ? (
                                  <div className="auto-plan-evidence-cell">
                                    <strong>{Number(slot.capability_score).toFixed(1)} · {slot.confidence_grade}级</strong>
                                    <small>
                                      ROI {slot.adjusted_roi_index == null ? '—' : Number(slot.adjusted_roi_index).toFixed(1)}
                                      {' · '}小时GMV {slot.adjusted_hourly_gmv_index == null ? '—' : Number(slot.adjusted_hourly_gmv_index).toFixed(1)}
                                    </small>
                                    <small>{sourceShortName(slot.source_document)} · {numberValue(slot.sample_hours)}h样本</small>
                                  </div>
                                ) : (
                                  <span className="muted">中性处理</span>
                                )}
                              </td>
                              <td data-label="安排说明">
                                <div className="auto-plan-reasons">
                                  <span className={`status tier-${(slot.preference_tier ?? 'neutral').toLowerCase()}`}>
                                    {tierLabels[slot.preference_tier ?? 'NEUTRAL'] ?? '中性安排'}
                                  </span>
                                  <small>{slot.reasons?.[0] ?? slot.notes ?? '按工时、休息和时段约束生成'}</small>
                                </div>
                              </td>
                              <td data-label="调整">
                                {slot.assignment_id ? (
                                  <div className="auto-plan-change-anchor">
                                    <select
                                      aria-label={`${slot.room_name} ${formatTime(slot.starts_at)} 更换主播`}
                                      value={selectedAnchor}
                                      disabled={!editable || isMutating || slot.locked}
                                      onChange={(event) =>
                                        setPendingAnchors((current) => ({
                                          ...current,
                                          [slot.assignment_id!]: event.target.value
                                        }))
                                      }
                                    >
                                      {options?.anchors.map((anchor) => {
                                        const profile = latestScores.get(`${slot.room_id}:${anchor.id}`);
                                        return (
                                          <option key={anchor.id} value={anchor.id}>
                                            {anchor.display_name} · {employmentLabel(anchor.employment_type)}{profile ? ` · ${Number(profile.capability_score).toFixed(1)} ${profile.confidence_grade}` : ''}
                                          </option>
                                        );
                                      })}
                                    </select>
                                    <button
                                      className="button secondary auto-plan-save-assignment"
                                      type="button"
                                      disabled={!editable || !changed || isMutating || slot.locked}
                                      onClick={() => void changeAssignment(slot)}
                                    >
                                      {busyAction === `assignment:${slot.assignment_id}` ? '保存中' : '保存'}
                                    </button>
                                    <button
                                      className="button secondary auto-plan-save-assignment"
                                      type="button"
                                      disabled={!editable || isMutating}
                                      title={slot.locked_reason ?? undefined}
                                      onClick={() => void toggleAssignmentLock(slot)}
                                    >
                                      {slot.locked ? <Unlock size={15} aria-hidden /> : <Lock size={15} aria-hidden />}
                                      {slot.locked ? '解锁' : '锁定'}
                                    </button>
                                    <label className="auto-plan-swap-choice">
                                      <input
                                        type="checkbox"
                                        checked={swapSelection.includes(slot.assignment_id)}
                                        disabled={!editable || isMutating || slot.locked || (!swapSelection.includes(slot.assignment_id) && swapSelection.length >= 2)}
                                        onChange={(event) =>
                                          setSwapSelection((current) =>
                                            event.target.checked
                                              ? [...current, slot.assignment_id!]
                                              : current.filter((id) => id !== slot.assignment_id)
                                          )
                                        }
                                      />
                                      换班
                                    </label>
                                    <label className="auto-plan-swap-choice">
                                      <input
                                        type="checkbox"
                                        checked={batchSelection.includes(slot.assignment_id)}
                                        disabled={!editable || isMutating || slot.locked}
                                        onChange={(event) =>
                                          setBatchSelection((current) =>
                                            event.target.checked
                                              ? [...current, slot.assignment_id!]
                                              : current.filter((id) => id !== slot.assignment_id)
                                          )
                                        }
                                      />
                                      批量
                                    </label>
                                    <details className="auto-plan-time-editor">
                                      <summary>精确调整时间/直播间</summary>
                                      <div>
                                        <label>
                                          开始
                                          <input
                                            type="datetime-local"
                                            value={timeEdit?.startsAt ?? ''}
                                            disabled={!editable || isMutating || slot.locked}
                                            onChange={(event) =>
                                              setTimeEdits((current) => ({
                                                ...current,
                                                [slot.assignment_id!]: {
                                                  ...timeEdit!,
                                                  startsAt: event.target.value
                                                }
                                              }))
                                            }
                                          />
                                        </label>
                                        <label>
                                          结束
                                          <input
                                            type="datetime-local"
                                            value={timeEdit?.endsAt ?? ''}
                                            disabled={!editable || isMutating || slot.locked}
                                            onChange={(event) =>
                                              setTimeEdits((current) => ({
                                                ...current,
                                                [slot.assignment_id!]: {
                                                  ...timeEdit!,
                                                  endsAt: event.target.value
                                                }
                                              }))
                                            }
                                          />
                                        </label>
                                        <label>
                                          直播间
                                          <select
                                            value={timeEdit?.roomId ?? slot.room_id}
                                            disabled={!editable || isMutating || slot.locked}
                                            onChange={(event) =>
                                              setTimeEdits((current) => ({
                                                ...current,
                                                [slot.assignment_id!]: {
                                                  ...timeEdit!,
                                                  roomId: event.target.value
                                                }
                                              }))
                                            }
                                          >
                                            {options?.rooms.map((room) => (
                                              <option key={room.id} value={room.id}>{room.name}</option>
                                            ))}
                                          </select>
                                        </label>
                                        <button
                                          className="button secondary"
                                          type="button"
                                          disabled={!timeChanged || isMutating || slot.locked}
                                          onClick={() => void moveResizeAssignment(slot)}
                                        >
                                          {busyAction === `time:${slot.assignment_id}` ? '保存中' : '保存时间'}
                                        </button>
                                      </div>
                                    </details>
                                    {slot.locked ? <small className="auto-plan-inline-warning">已锁定：不会被人工换人或交换</small> : null}
                                    {changed && score?.confidence_grade === 'C' ? (
                                      <small className="auto-plan-inline-warning">C级为短样本，仅作观察</small>
                                    ) : null}
                                  </div>
                                ) : (
                                  <small className="auto-plan-gap-help">
                                    先补人员班次或释放冲突，再重新生成草案
                                  </small>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty auto-plan-filter-empty">
                    <CalendarRange size={28} aria-hidden />
                    <p>
                      {plan.slots.length === 0 && preservedExistingSlots > 0
                        ? `旧正式排班占用了 ${preservedExistingSlots} 个候选时段，当前草案没有可调整内容。`
                        : '当前筛选没有排班时段。'}
                    </p>
                    {plan.slots.length === 0 && preservedExistingSlots > 0 ? (
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => {
                          setExistingSchedulePolicy('REPLACE_AUTO_PLAN');
                          const generator = document.getElementById('schedule-generator');
                          if (typeof generator?.scrollIntoView === 'function') {
                            generator.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }
                        }}
                      >
                        改为替换系统自动排班
                      </button>
                    ) : null}
                  </div>
                )}
              </section>

              <aside className="auto-plan-side-panels">
                <section className="card auto-plan-side-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">MONTHLY HOURS</p>
                      <h2>主播月工时</h2>
                    </div>
                    <UsersRound size={20} aria-hidden />
                  </div>
                  <div className="auto-plan-hours-summary" aria-label="主播月工时总览">
                    <span>
                      <strong>{anchorHoursSummary.total}</strong>
                      <small>已分配</small>
                    </span>
                    <span className={anchorHoursSummary.below ? 'is-warning' : undefined}>
                      <strong>{anchorHoursSummary.below}</strong>
                      <small>低于下限</small>
                    </span>
                    <span className={anchorHoursSummary.over ? 'is-danger' : undefined}>
                      <strong>{anchorHoursSummary.over}</strong>
                      <small>超过上限</small>
                    </span>
                    <span className="is-success">
                      <strong>{anchorHoursSummary.healthy}</strong>
                      <small>全职达标</small>
                    </span>
                  </div>
                  <div className="auto-plan-hours-list">
                    {anchorHoursView.length ? anchorHoursView.map((anchor) => (
                        <article
                          key={anchor.anchor_id}
                          className={anchor.over ? 'is-danger' : anchor.below ? 'is-warning' : ''}
                        >
                          <div>
                            <strong>{anchor.display_name}</strong>
                            <span>{employmentLabel(anchor.employment_type)} · {anchor.hours.toFixed(1)}h</span>
                          </div>
                          <div className="auto-plan-hours-track" aria-label={`${anchor.display_name} ${anchor.hours.toFixed(1)} 小时`}>
                            <i style={{ width: `${Math.min(100, (anchor.hours / anchor.max) * 100)}%` }} />
                          </div>
                          <small>
                            {anchor.over
                              ? '超过130小时上限'
                              : anchor.below
                                ? `距104小时还差 ${(plan.plan.rules_snapshot.fullTimeMinMonthlyHours - anchor.hours).toFixed(1)}h`
                                : anchor.fullTime
                                  ? '处于104–130小时范围'
                                  : anchor.employment_type === 'PART_TIME'
                                    ? '兼职不套用全职月工时下限'
                                    : '用工类型待确认，不参与全职目标判断'}
                          </small>
                          <small>
                            正式 {anchor.existingHours.toFixed(1)}h + 草案 {anchor.generatedHours.toFixed(1)}h
                          </small>
                        </article>
                      )) : (
                      <p className="muted">当前草案尚未安排主播。</p>
                    )}
                  </div>
                </section>

                <section className="card auto-plan-side-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">VALIDATION</p>
                      <h2>违规与提醒</h2>
                    </div>
                    <span className={
                      !validationCurrent
                        ? 'status warning'
                        : violationCounts.ERROR
                          ? 'status danger'
                          : 'status success'
                    }>
                      {!validationCurrent
                        ? '待校验'
                        : violationCounts.ERROR
                          ? `${violationCounts.ERROR} 个问题`
                          : '无硬约束问题'}
                    </span>
                  </div>
                  <div className="auto-plan-violation-list">
                    {plan.violations.length ? plan.violations.slice(0, 30).map((violation) => (
                      <article key={violation.id} className={`severity-${violation.severity.toLowerCase()}`}>
                        {violation.severity === 'ERROR' ? (
                          <AlertTriangle size={16} aria-hidden />
                        ) : (
                          <ShieldAlert size={16} aria-hidden />
                        )}
                        <div>
                          <strong>{violation.severity === 'ERROR' ? '必须处理' : '人工确认'}</strong>
                          <p>{violation.message}</p>
                        </div>
                      </article>
                    )) : (
                      <div className="auto-plan-no-violations">
                        <BadgeCheck size={24} aria-hidden />
                        <span>
                          {validationCurrent
                            ? '本次校验未发现违规。'
                            : '当前草案尚未校验；发布前必须执行一次完整校验。'}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              </aside>
            </div>

            <section className="card auto-plan-publish-bar">
              <div>
                <strong>
                  {formalScheduleFromFeishu
                    ? '辅助草案仅用于校验和参考'
                    : '发布前必须通过硬约束校验'}
                </strong>
                <span>
                  {assignedSlots > 0
                    ? '校验会重新检查单次连续5小时、跨日8小时休息、现有排班冲突、人员班次和月工时；同日不连续直播段分别计算。'
                    : '当前草案没有可发布的主播时段。请重新生成并选择“替换系统自动排班”，不要发布空草案。'}
                </span>
              </div>
              <div>
                <button
                  className="button secondary"
                  type="button"
                  disabled={!editable || isMutating || assignedSlots === 0}
                  onClick={() => void validate()}
                >
                  {busyAction === 'validate' ? <RefreshCw className="spin" size={17} /> : <ShieldAlert size={17} />}
                  重新校验
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={formalScheduleFromFeishu || plan.plan.status !== 'VALIDATED' || isMutating || assignedSlots === 0}
                  onClick={() => setPublishConfirm(true)}
                >
                  <Rocket size={17} aria-hidden />
                  {formalScheduleFromFeishu ? '正式排班请在飞书调整' : '发布正式排班'}
                </button>
              </div>
            </section>
          </>
        ) : null}

        {publishConfirm && plan ? (
          <div className="dialog-backdrop" role="presentation">
            <section className="dialog-card auto-plan-publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-plan-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">FINAL CONFIRMATION</p>
                  <h2 id="publish-plan-title">
                    确认发布 {plan.plan.schedule_month.slice(0, 7)} 排班？
                  </h2>
                </div>
                <button className="icon-button" type="button" aria-label="关闭" onClick={() => setPublishConfirm(false)}>
                  <X size={19} aria-hidden />
                </button>
              </div>
              <div className="alert-banner warning">
                <ShieldAlert size={18} aria-hidden />
                <div>
                  <strong>发布后会写入正式直播场次</strong>
                  <span>
                    草案中的 {assignedSlots} 个主播时段将进入排班中心；
                    {planReplacesAutoPlan
                      ? '同范围内未来的旧系统自动排班会在同一事务中取消，人工排班不会被覆盖。'
                      : '原有正式排班不会被覆盖。'}
                  </span>
                </div>
              </div>
              <dl className="auto-plan-confirm-facts">
                <div><dt>覆盖缺口</dt><dd>{unfilledSlots}</dd></div>
                <div><dt>硬约束问题</dt><dd>{violationCounts.ERROR}</dd></div>
                <div><dt>人工提醒</dt><dd>{violationCounts.WARNING}</dd></div>
              </dl>
              {violationCounts.WARNING > 0 ? (
                <label className="field">
                  软风险确认原因（必填）
                  <textarea
                    rows={3}
                    value={softRiskReason}
                    placeholder="说明为什么接受当前提醒，以及后续由谁跟进"
                    onChange={(event) => setSoftRiskReason(event.target.value)}
                  />
                </label>
              ) : null}
              <footer>
                <button className="button secondary" type="button" disabled={isMutating} onClick={() => setPublishConfirm(false)}>返回检查</button>
                <button className="button" type="button" disabled={isMutating || (violationCounts.WARNING > 0 && !softRiskReason.trim())} onClick={() => void publish()}>
                  {busyAction === 'publish' ? <RefreshCw className="spin" size={17} /> : <Rocket size={17} />}
                  确认发布
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
