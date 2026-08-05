'use client';

import {
  AlertTriangle,
  BellRing,
  CalendarRange,
  Clock3,
  Pencil,
  Radio,
  RefreshCw,
  Sparkles,
  Trash2,
  UsersRound
} from 'lucide-react';
import Link from 'next/link';
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { AppShell } from '@/components/app-shell';
import { StatusBadge, statusLabel } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { SectionTabs } from '@/components/section-tabs';
import { ApiError, api, formatDateTime, formatTime } from '@/lib/api';

type Tab = 'LIVE' | 'MONTHLY' | 'APPOINTMENTS';

interface Room {
  id: string;
  name: string;
}

interface LiveSession {
  id: string;
  room_id: string;
  room_name: string;
  anchor_id: string;
  anchor_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  schedule_type: string;
  makeup_required: boolean;
  field_control_id?: string;
  field_control_name?: string;
  source_type: string;
  notes?: string;
  version: number;
  appointment_status?: string;
  makeup_artist_name?: string;
  planned_start_at?: string;
  planned_end_at?: string;
}

interface LiveSlot {
  id: string;
  room_id: string;
  room_name: string;
  anchor_id?: string;
  anchor_name?: string;
  raw_anchor_name?: string;
  raw_value: string;
  starts_at: string;
  ends_at: string;
  schedule_type: string;
  exception_type?: string;
  parse_status: string;
}

interface FieldControl {
  id: string;
  display_name: string;
  raw_shift_value: string;
  starts_at?: string;
  ends_at?: string;
  parse_status: string;
  segments: Array<{ startsAt: string; endsAt: string; bookable: boolean }>;
}

interface LiveBoard {
  date: string;
  rooms: Room[];
  sessions: LiveSession[];
  slots: LiveSlot[];
  fieldControls: FieldControl[];
}

interface DayCell {
  id?: string;
  raw: string;
  startsAt?: string;
  endsAt?: string;
  parseStatus: string;
  isRest: boolean;
  isLeave?: boolean;
  shiftTemplateId?: string;
  sourceType?: string;
  notes?: string;
  source: 'STAFF_SCHEDULE' | 'LIVE_SCHEDULE';
  liveSessions?: Array<{
    id: string;
    roomId: string;
    roomName: string;
    startsAt: string;
    endsAt: string;
    scheduleType: string;
  }>;
}

interface MonthlyRow {
  id: string;
  name: string;
  role: string;
  employmentStatus?: string;
  days: Record<string, DayCell>;
}

interface MonthlyBoard {
  month: string;
  dayCount: number;
  sourceMode:
    | 'ANCHOR_LIVE_SCHEDULE'
    | 'STAFF_DAILY_SCHEDULE'
    | 'MIXED';
  people: MonthlyRow[];
}

interface Appointment {
  id: string;
  appointment_no: string;
  created_at: string;
  status: string;
  anchor_name: string;
  subject_type?: 'ANCHOR' | 'TALENT' | 'DIRECTOR';
  makeup_artist_name: string;
  requester_name: string;
  planned_start_at: string;
  planned_end_at: string;
  live_starts_at?: string | null;
  room_name: string;
  source_type: string;
  exception_type?: string;
}

interface ManagementPerson {
  id: string;
  display_name: string;
  employment_status: string;
  roles: string[];
}

interface ShiftTemplate {
  id: string;
  name: string;
  start_time?: string;
  end_time?: string;
  duration_minutes?: number;
  crosses_midnight: boolean;
  bookable: boolean;
  confirmation_required: boolean;
  segments: Array<{ startTime: string; endTime: string }>;
}

interface ManagementOptions {
  people: ManagementPerson[];
  rooms: Array<Room & { location?: string }>;
  shiftTemplates: ShiftTemplate[];
  dataAuthority: string;
  scheduleEditable: boolean;
  syncSupported: boolean;
}

interface ScheduleSourceStatus {
  dataAuthority: string;
  scheduleEditable: boolean;
  lastSyncedAt?: string | null;
  tables: Array<{
    table_id: string;
    table_name: string;
    business_type: string;
    enabled: boolean;
    field_mapping_count: number;
    last_synced_at?: string | null;
  }>;
}

interface StaffEditorValue {
  id?: string | undefined;
  personId: string;
  role: string;
  scheduleDate: string;
  shiftTemplateId: string;
  startsAt: string;
  endsAt: string;
  rawShiftValue: string;
  isRest: boolean;
  isLeave: boolean;
  notes: string;
}

type EditorState =
  | { type: 'LIVE'; session?: LiveSession }
  | { type: 'STAFF'; value: StaffEditorValue };

const roleLabels: Record<string, string> = {
  ANCHOR: '主播',
  FIELD_CONTROL: '场控',
  MAKEUP_ARTIST: '妆造'
};

const employmentStatusLabels: Record<string, string> = {
  ACTIVE: '在职',
  INACTIVE: '停用',
  ARCHIVED: '归档'
};

function localDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function localMonth(): string {
  return localDate().slice(0, 7);
}

function localHour(value: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false
  }).format(new Date(value));
  return Number(hour) % 24;
}

function expandLocalSessionsToHourlySlots(board: LiveBoard | null): LiveSlot[] {
  if (!board) return [];
  const dayStart = new Date(`${board.date}T00:00:00+08:00`).getTime();
  const slots: LiveSlot[] = [];
  for (const session of board.sessions) {
    const sessionStart = new Date(session.starts_at).getTime();
    const sessionEnd = new Date(session.ends_at).getTime();
    for (const hour of Array.from({ length: 24 }, (_, value) => value)) {
      const hourStart = dayStart + hour * 60 * 60 * 1000;
      const hourEnd = hourStart + 60 * 60 * 1000;
      const startsAt = Math.max(sessionStart, hourStart);
      const endsAt = Math.min(sessionEnd, hourEnd);
      if (startsAt >= endsAt) continue;
      slots.push({
        id: `${session.id}:${hour}`,
        room_id: session.room_id,
        room_name: session.room_name,
        anchor_id: session.anchor_id,
        anchor_name: session.anchor_name,
        raw_anchor_name: session.anchor_name,
        raw_value: session.anchor_name,
        starts_at: new Date(startsAt).toISOString(),
        ends_at: new Date(endsAt).toISOString(),
        schedule_type: session.schedule_type,
        parse_status: 'SUCCESS'
      });
    }
  }
  return slots;
}

function toLocalInput(value?: string): string {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function shanghaiIso(value: string): string | undefined {
  return value ? new Date(`${value}:00+08:00`).toISOString() : undefined;
}

function nextLocalDate(date: string): string {
  const value = new Date(`${date}T00:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + 1);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value);
}

function addLocalMinutes(value: string, minutes: number): string {
  const start = new Date(`${value}:00+08:00`);
  return toLocalInput(
    new Date(start.getTime() + minutes * 60_000).toISOString()
  );
}

function templateRange(
  date: string,
  template: ShiftTemplate,
  currentStart: string
): { startsAt: string; endsAt: string } {
  const firstSegment = template.segments?.[0];
  const lastSegment = template.segments?.at(-1);
  const startTime = firstSegment?.startTime ?? template.start_time;
  const endTime = lastSegment?.endTime ?? template.end_time;
  if (startTime && endTime) {
    const startsAt = `${date}T${startTime.slice(0, 5)}`;
    const crossesMidnight =
      template.crosses_midnight ||
      endTime.slice(0, 5) <= startTime.slice(0, 5);
    return {
      startsAt,
      endsAt: `${crossesMidnight ? nextLocalDate(date) : date}T${endTime.slice(
        0,
        5
      )}`
    };
  }
  const startsAt = currentStart || `${date}T09:30`;
  return {
    startsAt,
    endsAt: template.duration_minutes
      ? addLocalMinutes(startsAt, template.duration_minutes)
      : ''
  };
}

export default function SchedulePage() {
  const [tab, setTab] = useState<Tab>('LIVE');
  const [date, setDate] = useState(localDate());
  const [month, setMonth] = useState(localMonth());
  const [roomId, setRoomId] = useState('');
  const [role, setRole] = useState('');
  const [live, setLive] = useState<LiveBoard | null>(null);
  const [monthly, setMonthly] = useState<MonthlyBoard | null>(null);
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [management, setManagement] = useState<ManagementOptions | null>(null);
  const [sourceStatus, setSourceStatus] =
    useState<ScheduleSourceStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [assigningSessionId, setAssigningSessionId] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const loadLive = useCallback(async () => {
    setError('');
    setLive(null);
    try {
      const query = new URLSearchParams({ date });
      if (roomId) query.set('roomId', roomId);
      setLive(await api<LiveBoard>(`/schedules/live-board?${query}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '直播排班读取失败');
    }
  }, [date, roomId]);

  const loadMonthly = useCallback(async () => {
    setError('');
    setMonthly(null);
    try {
      const query = new URLSearchParams({ month });
      if (role) query.set('role', role);
      setMonthly(await api<MonthlyBoard>(`/schedules/monthly?${query}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '月排班读取失败');
    }
  }, [month, role]);

  const loadAppointments = useCallback(async () => {
    setError('');
    setAppointments(null);
    try {
      const query = new URLSearchParams({ date });
      setAppointments(
        await api<Appointment[]>(`/schedules/appointment-ledger?${query}`)
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '妆造预约读取失败');
    }
  }, [date]);

  const loadManagement = useCallback(async () => {
    try {
      const [options, source] = await Promise.all([
        api<ManagementOptions>('/schedules/manage/options'),
        api<ScheduleSourceStatus>('/schedules/source-status')
      ]);
      setManagement(options);
      setSourceStatus(source);
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status !== 403) {
        setError(reason instanceof Error ? reason.message : '排班编辑权限读取失败');
      }
      setManagement(null);
      setSourceStatus(null);
    }
  }, []);

  const syncFromFeishu = useCallback(async () => {
    setSyncing(true);
    setError('');
    try {
      const results = await api<
        Array<{
          status: string;
          fetched: number;
          created: number;
          updated: number;
          failed: number;
        }>
      >('/schedules/sync-feishu', { method: 'POST' });
      const fetched = results.reduce((total, item) => total + item.fetched, 0);
      const failed = results.reduce((total, item) => total + item.failed, 0);
      setNotice(
        failed
          ? `飞书排班已同步，共读取 ${fetched} 条，${failed} 条需处理`
          : `飞书排班同步完成，共读取 ${fetched} 条记录`
      );
      await Promise.all([
        loadLive(),
        loadMonthly(),
        loadManagement()
      ]);
      window.setTimeout(() => setNotice(''), 4_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '飞书排班同步失败');
    } finally {
      setSyncing(false);
    }
  }, [loadLive, loadManagement, loadMonthly]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (tab === 'LIVE') void loadLive();
      if (tab === 'MONTHLY') void loadMonthly();
      if (tab === 'APPOINTMENTS') void loadAppointments();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tab, loadAppointments, loadLive, loadMonthly]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadManagement(), 0);
    return () => window.clearTimeout(timer);
  }, [loadManagement]);

  const afterMutation = useCallback(
    async (message: string) => {
      setEditor(null);
      setNotice(message);
      await Promise.all([loadLive(), loadMonthly(), loadAppointments()]);
      window.setTimeout(() => setNotice(''), 4_000);
    },
    [loadAppointments, loadLive, loadMonthly]
  );

  const assignFieldControl = useCallback(
    async (session: LiveSession, fieldControlId: string) => {
      setAssigningSessionId(session.id);
      setError('');
      try {
        await api(`/schedules/manage/live-sessions/${session.id}/field-control`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...(fieldControlId ? { fieldControlId } : {})
          })
        });
        await afterMutation(
          fieldControlId ? '场控安排已保存并进入通知队列。' : '场控安排已解除。'
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '场控安排保存失败');
      } finally {
        setAssigningSessionId('');
      }
    },
    [afterMutation]
  );

  const openNewStaff = useCallback(
    (
      personId = '',
      staffRole = role || 'FIELD_CONTROL',
      scheduleDate = date
    ) => {
      setEditor({
        type: 'STAFF',
        value: {
          personId,
          role: staffRole,
          scheduleDate,
          shiftTemplateId: '',
          startsAt: `${scheduleDate}T09:30`,
          endsAt: `${scheduleDate}T18:30`,
          rawShiftValue: '',
          isRest: false,
          isLeave: false,
          notes: ''
        }
      });
    },
    [date, role]
  );

  const openExistingStaff = useCallback(
    (person: MonthlyRow, day: number, cell: DayCell) => {
      const scheduleDate = `${month}-${String(day).padStart(2, '0')}`;
      setEditor({
        type: 'STAFF',
        value: {
          id: cell.id,
          personId: person.id,
          role: person.role,
          scheduleDate,
          shiftTemplateId: cell.shiftTemplateId ?? '',
          startsAt: toLocalInput(cell.startsAt),
          endsAt: toLocalInput(cell.endsAt),
          rawShiftValue: cell.raw,
          isRest: cell.isRest,
          isLeave: Boolean(cell.isLeave),
          notes: cell.notes ?? ''
        }
      });
    },
    [month]
  );

  const localHourlySlots = useMemo(
    () => expandLocalSessionsToHourlySlots(live),
    [live]
  );

  const groupedSlots = useMemo(
    () =>
      (live?.rooms ?? []).map((room) => ({
        room,
        slots: localHourlySlots.filter(
          (slot) => slot.room_id === room.id
        )
      })),
    [live, localHourlySlots]
  );

  return (
    <AppShell>
      <main className="page schedule-page">
        <div className="schedule-heading">
          <div>
            <p className="eyebrow">SCHEDULING OVERVIEW</p>
            <h1 className="title">正式排班</h1>
            <p className="muted">
              一眼看清主播在哪个直播间、场控谁在上班，以及妆造是否已经安排。
            </p>
          </div>
          <div className="schedule-heading-actions">
            <div className="schedule-kpi">
              <span>数据来源</span>
              <strong>飞书正式排班</strong>
              {sourceStatus?.lastSyncedAt ? (
                <small>同步于 {formatDateTime(sourceStatus.lastSyncedAt)}</small>
              ) : null}
            </div>
            {management ? (
              <div className="schedule-action-group">
                <Link className="button secondary" href="/schedule/plans">
                  <Sparkles size={16} /> 月度辅助草案
                </Link>
                <button
                  className="button"
                  disabled={syncing}
                  onClick={() => void syncFromFeishu()}
                >
                  <RefreshCw size={16} className={syncing ? 'spin' : ''} />
                  {syncing ? '正在同步…' : '从飞书同步排班'}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {management ? (
          <SectionTabs
            label="排班管理模块"
            activeHref="/schedule"
            items={[
              { href: '/schedule/plans', label: '月度辅助方案', description: '仅供测算和人工参考' },
              { href: '/schedule', label: '飞书正式排班', description: '同步直播、人员与妆造日程' },
              { href: '/admin/scheduling', label: '排班资源', description: '资格、范围与能力依据' }
            ]}
          />
        ) : null}

        {notice ? (
          <div className="alert-banner success schedule-feedback">
            <BellRing size={18} />
            <div>
              <strong>{notice}</strong>
              <span>页面已重新读取飞书正式排班，本地预约和通知数据保持不变。</span>
            </div>
          </div>
        ) : null}

        <div className="view-tabs" role="tablist" aria-label="排班视图">
          <button
            className={tab === 'LIVE' ? 'active' : ''}
            onClick={() => setTab('LIVE')}
          >
            <Radio size={17} /> 直播排班
          </button>
          <button
            className={tab === 'MONTHLY' ? 'active' : ''}
            onClick={() => setTab('MONTHLY')}
          >
            <CalendarRange size={17} /> 人员排班
          </button>
          <button
            className={tab === 'APPOINTMENTS' ? 'active' : ''}
            onClick={() => setTab('APPOINTMENTS')}
          >
            <Sparkles size={17} /> 妆造日程
          </button>
        </div>

        <section className="schedule-toolbar card">
          {tab === 'MONTHLY' ? (
            <>
              <label className="field compact-field">
                月份
                <input
                  type="month"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                />
              </label>
              <label className="field compact-field">
                岗位
                <select value={role} onChange={(event) => setRole(event.target.value)}>
                  <option value="">全部岗位</option>
                  <option value="FIELD_CONTROL">场控</option>
                  <option value="ANCHOR">主播</option>
                  <option value="MAKEUP_ARTIST">妆造</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="field compact-field">
                日期
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              {tab === 'LIVE' && live?.rooms.length ? (
                <label className="field compact-field">
                  直播间
                  <select
                    value={roomId}
                    onChange={(event) => setRoomId(event.target.value)}
                  >
                    <option value="">全部直播间</option>
                    {live.rooms.map((room) => (
                      <option value={room.id} key={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          )}
          <div className="toolbar-note">
            {tab === 'MONTHLY'
              ? role === 'ANCHOR'
                ? '主播班次取自飞书主播直播排班表；同主播、同直播间的连续小时会自动合并。'
                : '人员班次取自飞书直播部门排班表；请在飞书修改后点击“从飞书同步排班”。'
              : tab === 'LIVE'
                ? '直播时段按飞书小时排班拆分展示；连续时段会合并供妆造预约和冲突校验使用。'
                : '保留预约提出人、主播、计划时间、执行状态和程序数据来源。'}
          </div>
        </section>

        {error ? (
          <div className="card hero-card schedule-error">
            <AlertTriangle size={18} /> {error}
          </div>
        ) : null}

        {tab === 'LIVE' ? (
          <LiveSchedule
            board={live}
            slots={localHourlySlots}
            groupedSlots={groupedSlots}
            canManage={Boolean(management?.scheduleEditable)}
            canAssignFieldControl={Boolean(management)}
            assigningSessionId={assigningSessionId}
            fieldControls={live?.fieldControls ?? []}
            onAssignFieldControl={assignFieldControl}
            onEdit={(session) => setEditor({ type: 'LIVE', session })}
          />
        ) : null}
        {tab === 'MONTHLY' ? (
          <MonthlySchedule
            board={monthly}
            canManage={Boolean(management?.scheduleEditable)}
            onEdit={openExistingStaff}
            onCreate={(person, day) =>
              openNewStaff(
                person.id,
                person.role,
                `${month}-${String(day).padStart(2, '0')}`
              )
            }
          />
        ) : null}
        {tab === 'APPOINTMENTS' ? (
          <AppointmentLedger rows={appointments} />
        ) : null}
        {editor && management?.scheduleEditable ? (
          editor.type === 'LIVE' ? (
            <LiveSessionEditor
              options={management}
              date={date}
              session={editor.session}
              onClose={() => setEditor(null)}
              onSaved={afterMutation}
            />
          ) : (
            <StaffShiftEditor
              options={management}
              initial={editor.value}
              onClose={() => setEditor(null)}
              onSaved={afterMutation}
            />
          )
        ) : null}
      </main>
    </AppShell>
  );
}

function LiveSchedule({
  board,
  slots,
  groupedSlots,
  canManage,
  canAssignFieldControl,
  assigningSessionId,
  fieldControls,
  onAssignFieldControl,
  onEdit
}: {
  board: LiveBoard | null;
  slots: LiveSlot[];
  groupedSlots: Array<{ room: Room; slots: LiveSlot[] }>;
  canManage: boolean;
  canAssignFieldControl: boolean;
  assigningSessionId: string;
  fieldControls: FieldControl[];
  onAssignFieldControl: (
    session: LiveSession,
    fieldControlId: string
  ) => Promise<void>;
  onEdit: (session: LiveSession) => void;
}) {
  if (!board) return <LoadingState label="正在整理直播时段与场控班次…" />;
  return (
    <div className="schedule-workspace">
      <section className="card timeline-board">
        <div className="board-header">
          <div>
            <p className="eyebrow">ROOM TIMELINE</p>
            <h2>主播直播时段</h2>
          </div>
          <span className="status success">{slots.length} 个飞书排班小时格</span>
        </div>
        <p className="timeline-source-note">
          每一列对应飞书主播排班中的一个小时，显示主播类型、人员与排班备注。
        </p>
        <div className="hour-grid-scroll">
          <div className="hour-grid">
            <div className="hour-grid-header">
              <div className="hour-grid-corner">直播间</div>
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour}>
                  {String(hour).padStart(2, '0')}–{String((hour + 1) % 24).padStart(2, '0')}
                </div>
              ))}
            </div>
            {groupedSlots.map(({ room, slots }) => (
              <div className="hour-grid-row" key={room.id}>
                <div className="room-label">
                  <strong>{room.name}</strong>
                  <span>{slots.length ? `${slots.length} 条明细` : '无排班'}</span>
                </div>
                {Array.from({ length: 24 }, (_, hour) => {
                  const hourSlots = slots.filter(
                    (slot) => localHour(slot.starts_at) === hour
                  );
                  const rawValues = [
                    ...new Set(hourSlots.map((slot) => slot.raw_value).filter(Boolean))
                  ];
                  const hasProblem = hourSlots.some(
                    (slot) =>
                      slot.parse_status !== 'SUCCESS' || Boolean(slot.exception_type)
                  );
                  return (
                    <div
                      className={`hour-cell ${
                        rawValues.length ? 'occupied' : 'empty-hour'
                      } ${hasProblem ? 'hour-problem' : ''}`}
                      key={hour}
                      title={
                        rawValues.length
                          ? `${String(hour).padStart(2, '0')}:00–${String(
                              (hour + 1) % 24
                            ).padStart(2, '0')}:00\n${rawValues.join('\n')}`
                          : '无排班'
                      }
                    >
                      {rawValues.length
                        ? rawValues.map((value) => (
                            <span key={value}>{value}</span>
                          ))
                        : <span aria-hidden>—</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {!groupedSlots.length ? (
            <div className="empty">当天没有已识别的直播间排班。</div>
          ) : null}
        </div>
        <div className="mobile-live-list">
          {slots.map((slot) => (
            <article key={slot.id}>
              <time>{formatTime(slot.starts_at)}</time>
              <div>
                <strong>{slot.raw_value}</strong>
                <span>{slot.room_name}</span>
                <small>
                  {formatTime(slot.starts_at)}–{formatTime(slot.ends_at)}
                </small>
              </div>
            </article>
          ))}
        </div>
        <div className="operational-session-list">
          <div className="board-header compact-board-header">
            <div>
              <p className="eyebrow">OPERABLE SESSIONS</p>
              <h3>可操作直播场次</h3>
            </div>
            <span className="status">{board.sessions.length} 场</span>
          </div>
          {board.sessions.map((session) => (
            <article key={session.id}>
              <div className="session-time-block">
                <strong>{formatTime(session.starts_at)}</strong>
                <span>至 {formatTime(session.ends_at)}</span>
              </div>
              <div>
                <strong>{session.anchor_name}</strong>
                <span>{session.room_name}</span>
              </div>
              <div>
                <span className="source-tag">
                  {session.source_type === 'FEISHU'
                    ? '飞书同步'
                    : session.source_type === 'LOCAL'
                    ? '本地新增'
                    : session.source_type === 'LOCAL_OVERRIDE'
                      ? '本地已调整'
                      : '自动排班'}
                </span>
                {canAssignFieldControl ? (
                  <label>
                    <span className="sr-only">安排场控</span>
                    <select
                      aria-label={`为 ${session.anchor_name} 安排场控`}
                      value={session.field_control_id ?? ''}
                      disabled={assigningSessionId === session.id}
                      onChange={(event) =>
                        void onAssignFieldControl(session, event.target.value)
                      }
                    >
                      <option value="">场控待安排</option>
                      {fieldControls.map((person) => (
                        <option value={person.id} key={person.id}>
                          {person.display_name}｜{person.raw_shift_value}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <small>
                    {session.field_control_name
                      ? `场控：${session.field_control_name}`
                      : '场控待安排'}
                  </small>
                )}
              </div>
              <div>
                <span
                  className={`status ${
                    session.appointment_status === 'COMPLETED'
                      ? 'success'
                      : session.appointment_status === 'IN_PROGRESS'
                        ? 'warning'
                        : ''
                  }`}
                >
                  {session.makeup_required
                    ? statusLabel(session.appointment_status ?? 'UNBOOKED')
                    : '无需妆造'}
                </span>
              </div>
              {canManage ? (
                <button
                  className="icon-button"
                  aria-label={`编辑 ${session.anchor_name} 的直播场次`}
                  onClick={() => onEdit(session)}
                >
                  <Pencil size={16} />
                </button>
              ) : null}
            </article>
          ))}
          {!board.sessions.length ? (
            <div className="empty compact-empty">
              当天还没有从飞书同步到连续直播场次，请先检查飞书排班后重新同步。
            </div>
          ) : null}
        </div>
      </section>

      <aside className="card field-control-panel">
        <div className="board-header">
          <div>
            <p className="eyebrow">FIELD CONTROL</p>
            <h2>场控当班</h2>
          </div>
          <UsersRound size={20} />
        </div>
        <div className="control-list">
          {board.fieldControls.map((person) => (
            <article key={person.id}>
              <div>
                <strong>{person.display_name ?? '待匹配人员'}</strong>
                <span className="role-tag control">场控</span>
              </div>
              <p>
                <Clock3 size={15} />
                {person.starts_at && person.ends_at
                  ? `${formatTime(person.starts_at)}–${formatTime(person.ends_at)}`
                  : person.raw_shift_value}
              </p>
              <small className={person.parse_status === 'SUCCESS' ? '' : 'warning-text'}>
                {person.parse_status === 'SUCCESS'
                  ? `班次：${person.raw_shift_value}`
                  : `班次待确认：${person.raw_shift_value}`}
              </small>
            </article>
          ))}
          {!board.fieldControls.length ? (
            <div className="empty compact-empty">当天没有已解析的场控班次。</div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function MonthlySchedule({
  board,
  canManage,
  onEdit,
  onCreate
}: {
  board: MonthlyBoard | null;
  canManage: boolean;
  onEdit: (person: MonthlyRow, day: number, cell: DayCell) => void;
  onCreate: (person: MonthlyRow, day: number) => void;
}) {
  const matrixRef = useRef<HTMLDivElement>(null);
  const filledDays = useMemo(() => {
    if (!board) return [];
    return [
      ...new Set(
        board.people.flatMap((person) =>
          Object.keys(person.days)
            .map(Number)
            .filter((day) => Number.isInteger(day) && day > 0)
        )
      )
    ].sort((left, right) => left - right);
  }, [board]);

  useEffect(() => {
    if (!board || !matrixRef.current) return;
    matrixRef.current.scrollLeft = 0;
  }, [board]);

  if (!board) return <LoadingState label="正在生成按人员 × 日期的月排班…" />;
  const days = Array.from({ length: board.dayCount }, (_, index) => index + 1);
  const isAnchorBoard = board.sourceMode === 'ANCHOR_LIVE_SCHEDULE';
  const firstFilledDay = filledDays[0];
  const latestFilledDay = filledDays.at(-1);
  const monthLabel = `${Number(board.month.slice(5, 7))}月`;
  const sourceIsIncomplete =
    isAnchorBoard &&
    (latestFilledDay === undefined || latestFilledDay < board.dayCount);
  return (
    <section className="card monthly-board">
      <div className="board-header">
        <div>
          <p className="eyebrow">
            {isAnchorBoard ? 'ANCHOR × LIVE SLOT' : 'PEOPLE × DATE'}
          </p>
          <h2>{isAnchorBoard ? '主播直播班次' : '完整排班明细'}</h2>
        </div>
        <div className="board-header-actions">
          {isAnchorBoard ? (
            <span className="source-tag">来源：直播间小时排班</span>
          ) : null}
          <span className="status">{board.people.length} 人</span>
        </div>
      </div>
      {sourceIsIncomplete ? (
        <div className="schedule-coverage-notice" role="status">
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>
              {latestFilledDay
                ? `${monthLabel}主播直播排班目前只录入到 ${latestFilledDay} 日`
                : `${monthLabel}尚未从飞书同步到主播直播排班`}
            </strong>
            <span>
              {latestFilledDay
                ? `${latestFilledDay + 1}–${board.dayCount} 日在当前飞书表格中尚无直播场次；历史排班没有被删除。`
                : '请确认飞书月份和日期列已有排班，然后点击“从飞书同步排班”。'}
            </span>
          </div>
          {firstFilledDay ? (
            <button
              className="button secondary coverage-jump-button"
              type="button"
              onClick={() => {
                if (matrixRef.current) matrixRef.current.scrollLeft = 0;
              }}
            >
              查看已排日期（{firstFilledDay}–{latestFilledDay}日）
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="matrix-wrap" ref={matrixRef}>
        <table className="schedule-matrix">
          <thead>
            <tr>
              <th className="sticky-person">人员</th>
              <th className="sticky-role">岗位</th>
              {days.map((day) => (
                <th key={day}>{day}日</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.people.map((person) => (
              <tr key={`${person.id}:${person.role}`}>
                <td className="sticky-person">
                  <strong>{person.name}</strong>
                  <small>
                    {employmentStatusLabels[person.employmentStatus ?? ''] ??
                      person.employmentStatus ??
                      '状态未填'}
                  </small>
                </td>
                <td className="sticky-role">
                  <span className={`role-tag ${person.role.toLowerCase()}`}>
                    {roleLabels[person.role] ?? person.role}
                  </span>
                </td>
                {days.map((day) => {
                  const cell = person.days[String(day)];
                  const isLiveCell =
                    cell?.source === 'LIVE_SCHEDULE' &&
                    Boolean(cell.liveSessions?.length);
                  return (
                    <td
                      key={day}
                      className={[
                        cell?.isRest ? 'rest-cell' : '',
                        isLiveCell ? 'live-schedule-cell' : '',
                        cell && cell.parseStatus !== 'SUCCESS'
                          ? 'unconfirmed-cell'
                          : ''
                      ].join(' ')}
                      title={
                        isLiveCell
                          ? cell.liveSessions
                              ?.map(
                                (session) =>
                                  `${session.roomName} ${formatTime(
                                    session.startsAt
                                  )}–${formatTime(session.endsAt)}`
                              )
                              .join('\n')
                          : cell?.startsAt && cell.endsAt
                          ? `${formatDateTime(cell.startsAt)}–${formatTime(cell.endsAt)}`
                          : cell?.parseStatus === 'NEEDS_CONFIRMATION'
                            ? '需要补充开始时间或配置班次模板'
                            : ''
                      }
                      onClick={
                        canManage && !isAnchorBoard
                          ? () =>
                              cell
                                ? onEdit(person, day, cell)
                                : onCreate(person, day)
                          : undefined
                      }
                      role={canManage && !isAnchorBoard ? 'button' : undefined}
                      tabIndex={canManage && !isAnchorBoard ? 0 : undefined}
                      onKeyDown={
                        canManage && !isAnchorBoard
                          ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                if (cell) onEdit(person, day, cell);
                                else onCreate(person, day);
                              }
                            }
                          : undefined
                      }
                    >
                      {isLiveCell ? (
                        <div className="anchor-live-slots">
                          {cell.liveSessions?.map((session) => (
                            <div className="anchor-live-slot" key={session.id}>
                              <strong>
                                {formatTime(session.startsAt)}–
                                {formatTime(session.endsAt)}
                              </strong>
                              <span>{session.roomName}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className={canManage ? 'editable-shift-cell' : ''}>
                          {cell?.raw ?? '—'}
                          {canManage ? <Pencil size={12} aria-hidden /> : null}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!board.people.length ? (
        <div className="empty">该月份尚未从飞书同步到排班明细。</div>
      ) : null}
    </section>
  );
}

function LiveSessionEditor({
  options,
  date,
  session,
  onClose,
  onSaved
}: {
  options: ManagementOptions;
  date: string;
  session: LiveSession | undefined;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const anchors = options.people.filter((person) =>
    person.roles.includes('ANCHOR')
  );
  const fieldControls = options.people.filter((person) =>
    person.roles.includes('FIELD_CONTROL')
  );
  const [roomId, setRoomId] = useState(
    session?.room_id ?? options.rooms[0]?.id ?? ''
  );
  const [anchorId, setAnchorId] = useState(
    session?.anchor_id ?? anchors[0]?.id ?? ''
  );
  const [fieldControlId, setFieldControlId] = useState(
    session?.field_control_id ?? ''
  );
  const [startsAt, setStartsAt] = useState(
    toLocalInput(session?.starts_at) || `${date}T10:00`
  );
  const [endsAt, setEndsAt] = useState(
    toLocalInput(session?.ends_at) || `${date}T11:00`
  );
  const [scheduleType, setScheduleType] = useState(
    session?.schedule_type ?? 'LIVE'
  );
  const [makeupRequired, setMakeupRequired] = useState(
    session?.makeup_required ?? true
  );
  const [notes, setNotes] = useState(session?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        roomId,
        anchorId,
        fieldControlId: fieldControlId || undefined,
        startsAt: shanghaiIso(startsAt),
        endsAt: shanghaiIso(endsAt),
        scheduleType,
        makeupRequired,
        notes: notes || undefined
      };
      await api(
        session
          ? `/schedules/manage/live-sessions/${session.id}`
          : '/schedules/manage/live-sessions',
        {
          method: session ? 'PATCH' : 'POST',
          body: JSON.stringify(body)
        }
      );
      await onSaved(session ? '直播排班已调整' : '直播场次已创建');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '直播排班保存失败');
    } finally {
      setBusy(false);
    }
  };

  const cancelSession = async () => {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ impactedAppointments: number }>(
        `/schedules/manage/live-sessions/${session.id}/cancel`,
        { method: 'POST' }
      );
      await onSaved(
        result.impactedAppointments
          ? `直播场次已取消，${result.impactedAppointments} 条预约进入待处理`
          : '直播场次已取消'
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '直播场次取消失败');
      setConfirmCancel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog-card schedule-editor"
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-labelledby="live-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">LIVE SESSION</p>
            <h2 id="live-editor-title">
              {session ? '调整直播场次' : '新增直播场次'}
            </h2>
          </div>
          <span className="source-tag">
            本地编排
          </span>
        </header>
        <p className="editor-help">
          保存时会重新检查直播间、主播和场控冲突；如影响已有妆造预约，会自动进入风险中心并通知相关人员。
        </p>
        {error ? (
          <div className="alert-banner danger">
            <AlertTriangle size={18} />
            <div>
              <strong>无法保存</strong>
              <span>{error}</span>
            </div>
          </div>
        ) : null}
        <div className="schedule-editor-grid">
          <label className="field">
            直播间
            <select
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              required
            >
              {options.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            主播
            <select
              value={anchorId}
              onChange={(event) => setAnchorId(event.target.value)}
              required
            >
              {anchors.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            开始时间
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              required
            />
          </label>
          <label className="field">
            结束时间
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              required
            />
          </label>
          <label className="field">
            场控
            <select
              value={fieldControlId}
              onChange={(event) => setFieldControlId(event.target.value)}
            >
              <option value="">暂不安排</option>
              {fieldControls.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            场次类型
            <select
              value={scheduleType}
              onChange={(event) => setScheduleType(event.target.value)}
            >
              <option value="LIVE">正常直播</option>
              <option value="REHEARSAL">彩排</option>
              <option value="TRAINING">培训</option>
            </select>
          </label>
          <label className="field schedule-editor-wide">
            备注
            <textarea
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="可填写交接、特殊开播时间或其他说明"
            />
          </label>
          <label className="checkbox-line schedule-editor-wide">
            <input
              type="checkbox"
              checked={makeupRequired}
              onChange={(event) => setMakeupRequired(event.target.checked)}
            />
            该主播场次需要妆造预约
          </label>
        </div>
        {confirmCancel ? (
          <div className="alert-banner danger">
            <AlertTriangle size={18} />
            <div>
              <strong>确认取消这场直播？</strong>
              <span>已有妆造预约不会被删除，而会进入待改期或风险处理。</span>
            </div>
            <button
              className="button danger"
              type="button"
              disabled={busy}
              onClick={() => void cancelSession()}
            >
              确认取消
            </button>
          </div>
        ) : null}
        <footer>
          {session ? (
            <button
              className="button danger secondary-action"
              type="button"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
            >
              <Trash2 size={16} /> 取消场次
            </button>
          ) : null}
          <span className="dialog-footer-spacer" />
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            返回
          </button>
          <button className="button" type="submit" disabled={busy}>
            {busy ? '正在校验…' : session ? '保存调整' : '创建并通知'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function StaffShiftEditor({
  options,
  initial,
  onClose,
  onSaved
}: {
  options: ManagementOptions;
  initial: StaffEditorValue;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const people = options.people.filter((person) =>
    person.roles.includes(value.role)
  );
  const update = <K extends keyof StaffEditorValue,>(
    key: K,
    next: StaffEditorValue[K]
  ) => setValue((current) => ({ ...current, [key]: next }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        value.id
          ? `/schedules/manage/staff-shifts/${value.id}`
          : '/schedules/manage/staff-shifts',
        {
          method: value.id ? 'PATCH' : 'POST',
          body: JSON.stringify({
            personId: value.personId,
            role: value.role,
            scheduleDate: value.scheduleDate,
            shiftTemplateId: value.shiftTemplateId || undefined,
            startsAt:
              value.isRest || value.isLeave
                ? undefined
                : shanghaiIso(value.startsAt),
            endsAt:
              value.isRest || value.isLeave
                ? undefined
                : shanghaiIso(value.endsAt),
            rawShiftValue: value.rawShiftValue || undefined,
            isRest: value.isRest,
            isLeave: value.isLeave,
            notes: value.notes || undefined
          })
        }
      );
      await onSaved(value.id ? '人员班次已调整' : '人员班次已创建');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人员班次保存失败');
    } finally {
      setBusy(false);
    }
  };

  const cancelShift = async () => {
    if (!value.id) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ impactedAppointments: number }>(
        `/schedules/manage/staff-shifts/${value.id}/cancel`,
        { method: 'POST' }
      );
      await onSaved(
        result.impactedAppointments
          ? `班次已取消，${result.impactedAppointments} 条妆造预约待重新分配`
          : '人员班次已取消'
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人员班次取消失败');
      setConfirmCancel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog-card schedule-editor"
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">STAFF SHIFT</p>
            <h2 id="staff-editor-title">
              {value.id ? '调整人员班次' : '新增人员班次'}
            </h2>
          </div>
          <span className="source-tag">
            {value.id ? '保留原排班审计' : '本地编排'}
          </span>
        </header>
        <p className="editor-help">
          行政班为 09:30–18:30（12:30–14:00 不可预约），培训班为
          10:00–16:00；自由班选择开始时间后会按 7 小时或 4 小时自动计算结束。
        </p>
        {error ? (
          <div className="alert-banner danger">
            <AlertTriangle size={18} />
            <div>
              <strong>无法保存</strong>
              <span>{error}</span>
            </div>
          </div>
        ) : null}
        <div className="schedule-editor-grid">
          <label className="field">
            岗位
            <select
              value={value.role}
              onChange={(event) => {
                const nextRole = event.target.value;
                const firstPerson = options.people.find((person) =>
                  person.roles.includes(nextRole)
                );
                setValue((current) => ({
                  ...current,
                  role: nextRole,
                  personId: firstPerson?.id ?? ''
                }));
              }}
            >
              <option value="ANCHOR">主播</option>
              <option value="FIELD_CONTROL">场控</option>
              <option value="MAKEUP_ARTIST">化妆师</option>
            </select>
          </label>
          <label className="field">
            人员
            <select
              value={value.personId}
              onChange={(event) => update('personId', event.target.value)}
              required
            >
              <option value="" disabled>
                请选择
              </option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            日期
            <input
              type="date"
              value={value.scheduleDate}
              onChange={(event) => update('scheduleDate', event.target.value)}
              required
            />
          </label>
          <label className="field">
            班次模板
            <select
              value={value.shiftTemplateId}
              onChange={(event) => {
                const template = options.shiftTemplates.find(
                  (item) => item.id === event.target.value
                );
                setValue((current) => ({
                  ...current,
                  shiftTemplateId: event.target.value,
                  rawShiftValue: template?.name ?? current.rawShiftValue,
                  ...(template
                    ? templateRange(
                        current.scheduleDate,
                        template,
                        current.startsAt
                      )
                    : {})
                }));
              }}
            >
              <option value="">自定义时间</option>
              {options.shiftTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            开始时间
            <input
              type="datetime-local"
              value={value.startsAt}
              disabled={value.isRest || value.isLeave}
              onChange={(event) => {
                const nextStart = event.target.value;
                const template = options.shiftTemplates.find(
                  (item) => item.id === value.shiftTemplateId
                );
                setValue((current) => ({
                  ...current,
                  startsAt: nextStart,
                  ...(template?.duration_minutes &&
                  !template.start_time &&
                  !template.segments?.length
                    ? {
                        endsAt: addLocalMinutes(
                          nextStart,
                          template.duration_minutes
                        )
                      }
                    : {})
                }));
              }}
              required={!value.isRest && !value.isLeave}
            />
          </label>
          <label className="field">
            结束时间
            <input
              type="datetime-local"
              value={value.endsAt}
              disabled={value.isRest || value.isLeave}
              onChange={(event) => update('endsAt', event.target.value)}
              required={!value.isRest && !value.isLeave}
            />
          </label>
          <label className="field schedule-editor-wide">
            班次显示名称
            <input
              value={value.rawShiftValue}
              onChange={(event) => update('rawShiftValue', event.target.value)}
              placeholder="例如：行政班、20-05、临时补班"
            />
          </label>
          <div className="schedule-availability-options schedule-editor-wide">
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={value.isRest}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    isRest: event.target.checked,
                    isLeave: event.target.checked ? false : current.isLeave
                  }))
                }
              />
              休息
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={value.isLeave}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    isLeave: event.target.checked,
                    isRest: event.target.checked ? false : current.isRest
                  }))
                }
              />
              请假
            </label>
          </div>
          <label className="field schedule-editor-wide">
            备注
            <textarea
              rows={3}
              value={value.notes}
              onChange={(event) => update('notes', event.target.value)}
              placeholder="说明临时调班、请假原因或交接事项"
            />
          </label>
        </div>
        {confirmCancel ? (
          <div className="alert-banner danger">
            <AlertTriangle size={18} />
            <div>
              <strong>确认取消这个班次？</strong>
              <span>若影响化妆师预约，系统会标记待重新分配并通知相关人员。</span>
            </div>
            <button
              className="button danger"
              type="button"
              disabled={busy}
              onClick={() => void cancelShift()}
            >
              确认取消
            </button>
          </div>
        ) : null}
        <footer>
          {value.id ? (
            <button
              className="button danger secondary-action"
              type="button"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
            >
              <Trash2 size={16} /> 取消班次
            </button>
          ) : null}
          <span className="dialog-footer-spacer" />
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            返回
          </button>
          <button className="button" type="submit" disabled={busy}>
            {busy ? '正在校验…' : value.id ? '保存调整' : '创建并通知'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function AppointmentLedger({ rows }: { rows: Appointment[] | null }) {
  if (!rows) return <LoadingState label="正在读取妆造预约明细…" />;
  return (
    <section className="card monthly-board">
      <div className="board-header">
        <div>
          <p className="eyebrow">MAKEUP LEDGER</p>
          <h2>妆造预约明细</h2>
        </div>
        <span className="status">{rows.length} 条</span>
      </div>
      <div className="matrix-wrap">
        <table className="appointment-ledger">
          <thead>
            <tr>
              <th>预约单</th>
              <th>妆造对象</th>
              <th>预约人</th>
              <th>化妆师</th>
              <th>计划妆造</th>
              <th>开播</th>
              <th>状态</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.appointment_no}</strong>
                  <small>{formatDateTime(row.created_at)} 提出</small>
                </td>
                <td>
                  {row.anchor_name}
                  {row.subject_type && row.subject_type !== 'ANCHOR' ? (
                    <small>
                      {row.subject_type === 'TALENT' ? '达人' : '编导'}
                    </small>
                  ) : null}
                </td>
                <td>{row.requester_name}</td>
                <td>{row.makeup_artist_name}</td>
                <td>
                  {formatDateTime(row.planned_start_at)}–
                  {formatTime(row.planned_end_at)}
                </td>
                <td>
                  {row.live_starts_at
                    ? formatDateTime(row.live_starts_at)
                    : '非直播预约'}
                </td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td>
                  <span className="source-tag">
                    程序
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length ? <div className="empty">当天还没有妆造预约。</div> : null}
    </section>
  );
}
