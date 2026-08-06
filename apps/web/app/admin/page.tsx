'use client';

import { PersonRole } from '@jishi/contracts';
import {
  Archive,
  Edit3,
  Plus,
  RotateCcw,
  Search,
  UserCheck,
  UsersRound,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import {
  AlertBanner,
  PersonAvatar,
  StatusBadge
} from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { api, formatDateTime } from '@/lib/api';

interface Person {
  id: string;
  display_name: string;
  legal_name?: string | null;
  employee_no?: string | null;
  feishu_open_id?: string | null;
  username?: string | null;
  has_local_password: boolean;
  employment_status: string;
  login_allowed: boolean;
  booking_allowed: boolean;
  last_login_at?: string | null;
  archived_at?: string | null;
  roles: PersonRole[];
  room_ids: string[];
}

interface Room {
  id: string;
  name: string;
}

interface RoleRecord {
  id: string;
  code: PersonRole;
  name: string;
  description: string;
  permissions: Array<{
    id: string;
    code: string;
    name: string;
    module: string;
  }>;
}

const roleLabels: Record<PersonRole, string> = {
  ANCHOR: '主播',
  TALENT: '达人',
  DIRECTOR: '编导',
  MAKEUP_ARTIST: '化妆师',
  FIELD_CONTROL: '场控',
  LIVE_SUPERVISOR: '直播主管',
  ADMIN: '系统管理员',
  DEVELOPER: '开发者'
};

const roleOptions = Object.entries(roleLabels) as Array<[PersonRole, string]>;
const employmentStatusLabels: Record<string, string> = {
  ACTIVE: '在职',
  ARCHIVED: '已归档'
};

interface CreatePersonForm {
  displayName: string;
  employeeNo: string;
  feishuOpenId: string;
  roles: PersonRole[];
}

const emptyCreatePerson: CreatePersonForm = {
  displayName: '',
  employeeNo: '',
  feishuOpenId: '',
  roles: []
};

export default function AdminPage() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'ARCHIVED' | ''>(
    'ACTIVE'
  );
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [accountUsername, setAccountUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createPersonForm, setCreatePersonForm] =
    useState<CreatePersonForm>(emptyCreatePerson);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [peopleResult, roomsResult, roleResult] = await Promise.all([
        api<Person[]>('/admin/people'),
        api<Room[]>('/admin/rooms'),
        api<RoleRecord[]>('/admin/roles')
      ]);
      setPeople(peopleResult);
      setRooms(roomsResult);
      setRoles(roleResult);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '管理数据加载失败');
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const filteredPeople = useMemo(
    () =>
      people?.filter(
        (person) =>
          (!search ||
            person.display_name.includes(search) ||
            person.employee_no?.includes(search)) &&
          (!roleFilter || person.roles.includes(roleFilter as PersonRole)) &&
          (!statusFilter ||
            (statusFilter === 'ARCHIVED'
              ? Boolean(person.archived_at)
              : !person.archived_at))
      ) ?? [],
    [people, roleFilter, search, statusFilter]
  );

  const openAccess = (person: Person) => {
    setSelected({ ...person });
    setAccountUsername(person.username ?? '');
    setNewPassword('');
    setArchiveConfirm(false);
  };

  const closeAccess = () => {
    setSelected(null);
    setAccountUsername('');
    setNewPassword('');
    setArchiveConfirm(false);
  };

  const toggleCreateRole = (role: PersonRole) => {
    setCreatePersonForm((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((item) => item !== role)
        : [...current.roles, role]
    }));
  };

  const createPerson = async () => {
    if (!createPersonForm.displayName.trim()) {
      setError('请填写人员姓名');
      return;
    }
    if (!createPersonForm.roles.length) {
      setError('至少选择一个岗位');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api('/admin/people', {
        method: 'POST',
        body: JSON.stringify({
          displayName: createPersonForm.displayName.trim(),
          employeeNo: createPersonForm.employeeNo.trim() || undefined,
          feishuOpenId: createPersonForm.feishuOpenId.trim() || undefined,
          roles: createPersonForm.roles
        })
      });
      setCreateOpen(false);
      setCreatePersonForm(emptyCreatePerson);
      setStatusFilter('ACTIVE');
      setMessage('人员已添加，可继续编辑登录账号、直播间范围和预约权限');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人员添加失败');
    } finally {
      setSaving(false);
    }
  };

  const savePermissions = async () => {
    if (!selected) return;
    if (selected.login_allowed && !accountUsername.trim()) {
      setError('允许登录前请先设置系统账号');
      return;
    }
    if (
      accountUsername.trim() &&
      !selected.has_local_password &&
      !newPassword
    ) {
      setError('首次创建系统账号时必须设置至少8位密码');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api(`/admin/people/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: selected.display_name.trim(),
          employeeNo: selected.employee_no?.trim() || undefined,
          feishuOpenId: selected.feishu_open_id?.trim() || undefined
        })
      });
      if (accountUsername.trim()) {
        await api(`/admin/people/${selected.id}/account`, {
          method: 'PATCH',
          body: JSON.stringify({
            username: accountUsername.trim(),
            ...(newPassword ? { password: newPassword } : {})
          })
        });
      }
      await api(`/admin/people/${selected.id}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify({
          loginAllowed: selected.login_allowed,
          bookingAllowed: selected.booking_allowed,
          roles: selected.roles,
          roomIds: selected.room_ids
        })
      });
      closeAccess();
      setMessage('系统账号、人员角色和数据范围已更新，并写入操作日志');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人员权限保存失败');
    } finally {
      setSaving(false);
    }
  };

  const changeArchiveState = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const restore = Boolean(selected.archived_at);
      await api(
        `/admin/people/${selected.id}/${restore ? 'restore' : 'archive'}`,
        { method: 'POST' }
      );
      closeAccess();
      setMessage(
        restore
          ? '人员已恢复；登录和预约开关仍需管理员重新确认'
          : '人员已归档，历史排班和预约记录已保留'
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人员状态更新失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleRole = (role: PersonRole) => {
    if (!selected) return;
    setSelected({
      ...selected,
      roles: selected.roles.includes(role)
        ? selected.roles.filter((item) => item !== role)
        : [...selected.roles, role]
    });
  };

  const toggleRoom = (roomId: string) => {
    if (!selected) return;
    setSelected({
      ...selected,
      room_ids: selected.room_ids.includes(roomId)
        ? selected.room_ids.filter((item) => item !== roomId)
        : [...selected.room_ids, roomId]
    });
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">ADMIN CONSOLE</p>
            <h1 className="title">人员管理</h1>
            <p className="muted">
              在一个页面完成系统账号、岗位角色、直播间范围和业务开关配置。
            </p>
          </div>
          <button
            className="button"
            type="button"
            onClick={() => {
              setCreatePersonForm(emptyCreatePerson);
              setCreateOpen(true);
              setError('');
            }}
          >
            <Plus size={17} aria-hidden />
            添加人员
          </button>
        </header>

        {error ? <AlertBanner tone="danger" title={error} /> : null}
        {message ? <AlertBanner tone="success" title={message} /> : null}

        <section className="metric-grid admin-people-metrics" aria-label="人员管理概览">
          <article className="metric-card">
            <span>人员总数</span>
            <strong>{people?.length ?? '—'}</strong>
            <small>包括在职、试用和归档人员</small>
          </article>
          <article className="metric-card">
            <span>允许登录</span>
            <strong>{people?.filter((person) => person.login_allowed).length ?? '—'}</strong>
            <small>已开放系统工作台</small>
          </article>
          <article className="metric-card">
            <span>已有账号</span>
            <strong>{people?.filter((person) => person.username).length ?? '—'}</strong>
            <small>可直接使用账号密码登录</small>
          </article>
          <article className="metric-card">
            <span>待配置角色</span>
            <strong>{people?.filter((person) => person.roles.length === 0).length ?? '—'}</strong>
            <small>需要管理员补充岗位权限</small>
          </article>
        </section>

        <section className="card admin-people-panel" id="people">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">PEOPLE & ACCESS</p>
              <h2>
                <UsersRound size={19} aria-hidden />
                人员与身份绑定
              </h2>
            </div>
            <div className="panel-heading-actions">
              <span className="status-badge neutral">
                {filteredPeople.length} 人
              </span>
            </div>
          </div>
          <div className="admin-filters">
            <label className="admin-filter-field search-filter-field">
              <span>搜索人员</span>
              <span className="search-field">
                <Search size={17} aria-hidden />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="姓名或员工编号"
                />
              </span>
            </label>
            <label className="admin-filter-field">
              <span>岗位筛选</span>
              <select
                aria-label="岗位筛选"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value)}
              >
                <option value="">全部岗位</option>
                {roleOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-filter-field">
              <span>人员状态</span>
              <select
                aria-label="人员状态筛选"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(
                    event.target.value as 'ACTIVE' | 'ARCHIVED' | ''
                  )
                }
              >
                <option value="ACTIVE">在职人员</option>
                <option value="ARCHIVED">已归档人员</option>
                <option value="">全部人员</option>
              </select>
            </label>
          </div>

          {!people ? <LoadingState label="正在读取人员主数据…" /> : null}
          {people ? (
            <div className="admin-people-table">
              <div className="admin-person-row heading">
                <span>人员</span>
                <span>岗位</span>
                <span>在职状态</span>
                <span>系统账号</span>
                <span>登录 / 预约</span>
                <span>最后登录</span>
                <span>操作</span>
              </div>
              {filteredPeople.map((person) => (
                <article className="admin-person-row" key={person.id}>
                  <span className="person-cell">
                    <PersonAvatar name={person.display_name} size="sm" />
                    <span>
                      <strong>{person.display_name}</strong>
                      <small>{person.employee_no ?? '未填写员工编号'}</small>
                    </span>
                  </span>
                  <span className="role-cell">
                    {person.roles.length
                      ? person.roles.map((role) => (
                          <em key={role}>{roleLabels[role]}</em>
                        ))
                      : '待配置'}
                  </span>
                  <span>
                    {person.archived_at
                      ? '已归档'
                      : employmentStatusLabels[person.employment_status] ??
                        person.employment_status}
                  </span>
                  <span>
                    {person.username ? (
                      <>
                        <strong>{person.username}</strong>
                        <small className="table-subline">密码已设置</small>
                      </>
                    ) : (
                      <StatusBadge status="PENDING" label="待创建" />
                    )}
                  </span>
                  <span>
                    {person.login_allowed ? '可登录' : '禁止登录'} ·{' '}
                    {person.booking_allowed ? '可预约' : '不可预约'}
                  </span>
                  <span>
                    {person.last_login_at
                      ? formatDateTime(person.last_login_at)
                      : '从未登录'}
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`编辑${person.display_name}`}
                    onClick={() => openAccess(person)}
                  >
                    <Edit3 size={16} aria-hidden />
                  </button>
                </article>
              ))}
              {!filteredPeople.length ? (
                <div className="admin-people-empty">
                  当前筛选条件下没有人员，请调整岗位或人员状态。
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="card permission-matrix">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">PERMISSION MATRIX</p>
              <h2>
                <UserCheck size={19} aria-hidden />
                角色功能权限
              </h2>
            </div>
          </div>
          <div className="permission-role-grid">
            {roles.map((role) => (
              <article key={role.id}>
                <strong>{role.name}</strong>
                <small>{role.description}</small>
                <div>
                  {role.permissions.map((permission) => (
                    <span key={permission.id}>{permission.name}</span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        {createOpen ? (
          <div className="dialog-backdrop" role="presentation">
            <section className="dialog-card access-dialog" role="dialog" aria-modal>
              <header>
                <div>
                  <p className="eyebrow">ADD PERSON</p>
                  <h2>添加人员</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭添加人员"
                  onClick={() => setCreateOpen(false)}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <fieldset>
                <legend>人员资料</legend>
                <div className="account-field-grid">
                  <label>
                    姓名
                    <input
                      autoFocus
                      value={createPersonForm.displayName}
                      onChange={(event) =>
                        setCreatePersonForm((current) => ({
                          ...current,
                          displayName: event.target.value
                        }))
                      }
                      placeholder="请输入姓名"
                    />
                  </label>
                  <label>
                    员工编号（选填）
                    <input
                      value={createPersonForm.employeeNo}
                      onChange={(event) =>
                        setCreatePersonForm((current) => ({
                          ...current,
                          employeeNo: event.target.value
                        }))
                      }
                      placeholder="用于人员唯一匹配"
                    />
                  </label>
                </div>
                <label>
                  飞书 Open ID（选填）
                  <input
                    value={createPersonForm.feishuOpenId}
                    onChange={(event) =>
                      setCreatePersonForm((current) => ({
                        ...current,
                        feishuOpenId: event.target.value
                      }))
                    }
                    placeholder="ou_...，化妆师群内@提醒需要"
                  />
                </label>
              </fieldset>
              <fieldset>
                <legend>岗位角色</legend>
                <div className="checkbox-grid">
                  {roleOptions.map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={createPersonForm.roles.includes(value)}
                        onChange={() => toggleCreateRole(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <small className="muted">
                  添加后可继续创建登录账号、设置直播间范围和预约权限。
                </small>
              </fieldset>
              <footer>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setCreateOpen(false)}
                >
                  取消
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={
                    saving ||
                    !createPersonForm.displayName.trim() ||
                    !createPersonForm.roles.length
                  }
                  onClick={() => void createPerson()}
                >
                  <Plus size={16} aria-hidden />
                  {saving ? '添加中…' : '确认添加'}
                </button>
              </footer>
            </section>
          </div>
        ) : null}

        {selected ? (
          <div className="dialog-backdrop" role="presentation">
            <section className="dialog-card access-dialog" role="dialog" aria-modal>
              <header>
                <div>
                  <p className="eyebrow">ACCESS CONTROL</p>
                  <h2>编辑{selected.display_name}</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭"
                  onClick={closeAccess}
                >
                  <X size={18} aria-hidden />
                </button>
              </header>
              <fieldset>
                <legend>人员资料</legend>
                <div className="account-field-grid">
                  <label>
                    姓名
                    <input
                      value={selected.display_name}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          display_name: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    员工编号（选填）
                    <input
                      value={selected.employee_no ?? ''}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          employee_no: event.target.value
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  飞书 Open ID（用于群内@提醒）
                  <input
                    value={selected.feishu_open_id ?? ''}
                    onChange={(event) =>
                      setSelected({
                        ...selected,
                        feishu_open_id: event.target.value
                      })
                    }
                    placeholder="ou_..."
                  />
                </label>
                {selected.roles.includes('MAKEUP_ARTIST') &&
                !selected.feishu_open_id ? (
                  <small className="danger-text">
                    未绑定 Open ID 时群消息仍会发送，但无法自动@这名化妆师。
                  </small>
                ) : null}
              </fieldset>
              <fieldset>
                <legend>系统登录账号</legend>
                <div className="account-field-grid">
                  <label>
                    登录账号
                    <input
                      autoComplete="off"
                      value={accountUsername}
                      onChange={(event) => setAccountUsername(event.target.value)}
                      placeholder="员工编号、手机号或自定义账号"
                    />
                  </label>
                  <label>
                    {selected.has_local_password ? '重置密码（选填）' : '初始密码'}
                    <input
                      autoComplete="new-password"
                      type="password"
                      minLength={8}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      placeholder={
                        selected.has_local_password
                          ? '留空则保持原密码'
                          : '至少8位'
                      }
                    />
                  </label>
                </div>
                <small className="muted">
                  员工直接使用这里的账号密码登录，不再进行飞书授权。
                </small>
              </fieldset>
              <fieldset>
                <legend>岗位角色</legend>
                <div className="checkbox-grid">
                  {roleOptions.map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={selected.roles.includes(value)}
                        onChange={() => toggleRole(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>直播间数据范围</legend>
                <div className="checkbox-grid">
                  {rooms.map((room) => (
                    <label key={room.id}>
                      <input
                        type="checkbox"
                        checked={selected.room_ids.includes(room.id)}
                        onChange={() => toggleRoom(room.id)}
                      />
                      {room.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>账号开关</legend>
                <div className="checkbox-grid">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.login_allowed}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          login_allowed: event.target.checked
                        })
                      }
                    />
                    允许登录
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.booking_allowed}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          booking_allowed: event.target.checked
                        })
                      }
                    />
                    {selected.roles.includes('MAKEUP_ARTIST')
                      ? '允许被预约'
                      : selected.roles.includes('FIELD_CONTROL')
                        ? '允许代预约'
                        : '允许发起预约'}
                  </label>
                </div>
              </fieldset>
              {archiveConfirm ? (
                <AlertBanner tone="danger" title="确认归档这名人员？">
                  归档后不能登录、发起预约或被预约；历史排班和预约记录会完整保留。
                </AlertBanner>
              ) : null}
              <footer className="access-dialog-footer">
                <div className="person-lifecycle-actions">
                  {selected.archived_at ? (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={saving}
                      onClick={() => void changeArchiveState()}
                    >
                      <RotateCcw size={16} aria-hidden />
                      恢复人员
                    </button>
                  ) : archiveConfirm ? (
                    <>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => setArchiveConfirm(false)}
                      >
                        暂不归档
                      </button>
                      <button
                        className="button danger"
                        type="button"
                        disabled={saving}
                        onClick={() => void changeArchiveState()}
                      >
                        确认归档
                      </button>
                    </>
                  ) : (
                    <button
                      className="button secondary danger secondary-action"
                      type="button"
                      onClick={() => setArchiveConfirm(true)}
                    >
                      <Archive size={16} aria-hidden />
                      归档人员
                    </button>
                  )}
                </div>
                <div className="dialog-primary-actions">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={closeAccess}
                  >
                    取消
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={
                      saving ||
                      selected.roles.length === 0 ||
                      Boolean(selected.archived_at)
                    }
                    onClick={() => void savePermissions()}
                  >
                    {saving ? '保存中…' : '保存人员与权限'}
                  </button>
                </div>
              </footer>
            </section>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
