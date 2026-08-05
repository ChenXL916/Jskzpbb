'use client';

import { CurrentUser, PersonRole } from '@jishi/contracts';
import {
  Activity,
  Bell,
  CalendarDays,
  CalendarRange,
  CircleUserRound,
  ClipboardCheck,
  ClipboardList,
  Database,
  Gauge,
  LogIn,
  LogOut,
  Menu,
  Radio,
  Rows3,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  WandSparkles,
  X
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ComponentType,
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useState
} from 'react';
import { API_URL, ApiError, api } from '@/lib/api';
import { LoadingState } from './loading-state';

interface AppShellProps {
  children: ReactNode;
}

interface NavigationItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  section?: string;
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

const fullManagementNavigation: NavigationItem[] = [
  { href: '/management', label: '运营总览', icon: Gauge, section: '业务运营' },
  { href: '/schedule', label: '正式排班', icon: Radio, section: '业务运营' },
  {
    href: '/schedule/plans',
    label: '月度辅助排班',
    icon: CalendarRange,
    section: '业务运营'
  },
  { href: '/control', label: '直播间协同', icon: Rows3, section: '业务运营' },
  { href: '/requester', label: '妆造预约入口', icon: WandSparkles, section: '妆造协同' },
  { href: '/makeup/tasks', label: '妆造任务', icon: Sparkles, section: '妆造协同' },
  { href: '/appointments', label: '预约记录', icon: ClipboardList, section: '妆造协同' },
  { href: '/risks', label: '风险中心', icon: Activity, section: '妆造协同' },
  { href: '/notifications', label: '通知中心', icon: Bell, section: '妆造协同' },
  { href: '/admin', label: '人员与权限', icon: UsersRound, section: '系统管理' },
  { href: '/admin/scheduling', label: '排班资源', icon: CalendarDays, section: '系统管理' },
  { href: '/admin/rules', label: '预约规则', icon: ShieldCheck, section: '系统管理' },
  { href: '/admin/shifts', label: '班次模板', icon: CalendarRange, section: '系统管理' },
  { href: '/admin/notifications', label: '排班通知', icon: Bell, section: '系统管理' },
  { href: '/admin/feishu', label: '飞书数据源', icon: Database, section: '数据与诊断' },
  { href: '/admin/sync', label: '同步记录', icon: Activity, section: '数据与诊断' },
  { href: '/admin/logs', label: '操作日志', icon: ClipboardCheck, section: '数据与诊断' },
  { href: '/admin/settings', label: '系统设置', icon: Settings2, section: '数据与诊断' }
];

export const navigationByRole: Record<PersonRole, NavigationItem[]> = {
  ANCHOR: [
    { href: '/today', label: '今日', icon: CalendarDays },
    { href: '/my-schedule', label: '我的排班', icon: Rows3 },
    { href: '/appointments', label: '我的妆造', icon: ClipboardList },
    { href: '/notifications', label: '通知', icon: Bell },
    { href: '/profile', label: '我的', icon: CircleUserRound }
  ],
  TALENT: [
    { href: '/requester', label: '化妆师可预约', icon: WandSparkles }
  ],
  DIRECTOR: [
    { href: '/requester', label: '化妆师可预约', icon: WandSparkles }
  ],
  MAKEUP_ARTIST: [
    { href: '/makeup/tasks', label: '今日任务', icon: Sparkles },
    { href: '/my-schedule', label: '我的排班', icon: Rows3 },
    { href: '/appointments', label: '历史任务', icon: ClipboardList },
    { href: '/notifications', label: '通知', icon: Bell },
    { href: '/profile', label: '我的', icon: CircleUserRound }
  ],
  FIELD_CONTROL: [
    { href: '/control', label: '今日直播间', icon: Radio },
    { href: '/my-schedule', label: '我的排班', icon: Rows3 },
    { href: '/appointments', label: '妆造进度', icon: ClipboardCheck },
    { href: '/risks', label: '风险中心', icon: Activity },
    { href: '/profile', label: '我的', icon: CircleUserRound }
  ],
  LIVE_SUPERVISOR: [
    { href: '/management', label: '运营总览', icon: Gauge },
    { href: '/schedule/plans', label: '排班管理', icon: CalendarRange },
    { href: '/control', label: '妆造协同', icon: WandSparkles },
    { href: '/risks', label: '风险中心', icon: Activity },
    { href: '/admin', label: '管理', icon: Settings2 }
  ],
  ADMIN: fullManagementNavigation,
  DEVELOPER: fullManagementNavigation
};

const rolePriority: PersonRole[] = [
  'DEVELOPER',
  'ADMIN',
  'LIVE_SUPERVISOR',
  'FIELD_CONTROL',
  'MAKEUP_ARTIST',
  'TALENT',
  'DIRECTOR',
  'ANCHOR'
];

// Version the key so older sessions that were left in a restricted preview do
// not make a developer appear to have lost platform functionality.
const previewRoleStorageKey = 'jishi.developerPreviewRole.v2';

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataUpdated, setDataUpdated] = useState(false);
  const [previewRole, setPreviewRole] = useState<PersonRole>(() => {
    if (typeof window === 'undefined') return 'DEVELOPER';
    const savedRole = window.sessionStorage.getItem(
      previewRoleStorageKey
    ) as PersonRole | null;
    return savedRole && rolePriority.includes(savedRole)
      ? savedRole
      : 'DEVELOPER';
  });
  const [authState, setAuthState] = useState<
    'LOADING' | 'AUTHENTICATED' | 'ANONYMOUS' | 'ERROR'
  >('LOADING');

  useEffect(() => {
    void api<CurrentUser>('/auth/me')
      .then((currentUser) => {
        setUser(currentUser);
        setAuthState('AUTHENTICATED');
      })
      .catch((reason: unknown) => {
        setUser(null);
        setAuthState(
          reason instanceof ApiError && reason.status === 401
            ? 'ANONYMOUS'
            : 'ERROR'
        );
      });
  }, []);

  useEffect(() => {
    if (
      authState !== 'AUTHENTICATED' ||
      typeof EventSource === 'undefined'
    ) {
      return;
    }
    const events = new EventSource(`${API_URL}/events`, {
      withCredentials: true
    });
    const onChange = () => {
      setDataUpdated(true);
      window.dispatchEvent(new CustomEvent('jishi:data-updated'));
    };
    for (const eventName of [
      'appointment.booked',
      'appointment.in_progress',
      'appointment.completed',
      'appointment.cancelled',
      'appointment.exception',
      'appointment.rescheduled',
      'schedule.plan.generated',
      'schedule.plan.updated',
      'schedule.plan.published'
    ]) {
      events.addEventListener(eventName, onChange);
    }
    return () => events.close();
  }, [authState]);

  const primaryRole = useMemo(
    () => rolePriority.find((role) => user?.roles.includes(role)) ?? 'ANCHOR',
    [user]
  );

  const navigationRole =
    primaryRole === 'DEVELOPER' ? previewRole : primaryRole;
  const isDeveloperPreview =
    primaryRole === 'DEVELOPER' && navigationRole !== 'DEVELOPER';
  const navigation = navigationByRole[navigationRole];
  const hasScheduleManagementAccess = user?.roles.some((role) =>
    ['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER'].includes(role)
  );
  const hasPersonalScheduleAccess = user?.roles.some((role) =>
    [
      'ANCHOR',
      'MAKEUP_ARTIST',
      'FIELD_CONTROL',
      'LIVE_SUPERVISOR',
      'ADMIN',
      'DEVELOPER'
    ].includes(role)
  );
  const isScheduleManagementRoute =
    pathname === '/schedule' ||
    pathname.startsWith('/schedule/') ||
    pathname === '/admin/scheduling';
  const isShiftTemplateRoute = pathname === '/admin/shifts';
  const accessDenied =
    (isScheduleManagementRoute && !hasScheduleManagementAccess) ||
    (isShiftTemplateRoute &&
      !user?.roles.some((role) => ['ADMIN', 'DEVELOPER'].includes(role))) ||
    (pathname === '/my-schedule' && !hasPersonalScheduleAccess);
  const mobileNavigation = navigation.slice(0, 5);
  const activeNavigationIndex = (() => {
    const exact = navigation.findIndex(
      (item) => pathname === item.href.split('#')[0]
    );
    if (exact >= 0) return exact;
    let match = -1;
    let matchLength = -1;
    navigation.forEach((item, index) => {
      const basePath = item.href.split('#')[0]!;
      if (
        basePath !== '/admin' &&
        pathname.startsWith(`${basePath}/`) &&
        basePath.length > matchLength
      ) {
        match = index;
        matchLength = basePath.length;
      }
    });
    return match;
  })();

  if (authState === 'LOADING') {
    return (
      <div className="shell shell-auth">
        <main className="page auth-gate-page">
          <LoadingState label="正在确认登录状态…" />
        </main>
      </div>
    );
  }

  if (authState === 'ANONYMOUS') {
    return (
      <div className="shell shell-auth">
        <main className="page auth-gate-page">
          <section className="card auth-gate">
            <span className="status warning">需要登录</span>
            <h1>使用系统账号进入</h1>
            <p>
              登录后，系统会根据人员角色显示主播、化妆师、场控或管理工作台。
            </p>
            <Link className="button auth-login-button" href="/">
              <LogIn size={18} aria-hidden />
              账号密码登录
            </Link>
            <small>账号由管理员创建，如忘记密码请联系管理员重置。</small>
          </section>
        </main>
      </div>
    );
  }

  if (authState === 'ERROR' || !user) {
    return (
      <div className="shell shell-auth">
        <main className="page auth-gate-page">
          <section className="card auth-gate">
            <span className="status danger">连接失败</span>
            <h1>暂时无法确认登录状态</h1>
            <p>请确认接口服务正在运行，然后刷新页面重试。</p>
            <button
              className="button secondary"
              onClick={() => window.location.reload()}
            >
              刷新重试
            </button>
          </section>
        </main>
      </div>
    );
  }

  const logout = async () => {
    await api<void>('/auth/logout', { method: 'POST' });
    router.replace('/');
    router.refresh();
  };

  return (
    <div className="app-frame">
      <aside className={`side-nav${menuOpen ? ' is-open' : ''}`}>
        <div className="side-nav-brand">
          <span className="brand-mark">吉</span>
          <span>
            <strong>吉拾开张</strong>
            <small>直播排班与妆造协同</small>
          </span>
          <button
            className="icon-button side-nav-close"
            type="button"
            aria-label="关闭导航"
            onClick={() => setMenuOpen(false)}
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        {isDeveloperPreview ? (
          <button
            className="developer-preview-exit"
            type="button"
            onClick={() => {
              setPreviewRole('DEVELOPER');
              window.sessionStorage.setItem(
                previewRoleStorageKey,
                'DEVELOPER'
              );
              router.push('/management');
            }}
          >
            <ShieldCheck size={17} aria-hidden />
            <span>
              <strong>正在预览{roleLabels[navigationRole]}</strong>
              <small>返回开发者全部功能</small>
            </span>
          </button>
        ) : null}
        <nav className="side-nav-links" aria-label="主要导航">
          {navigation.map((item, index) => {
            const Icon = item.icon;
            const showSection =
              item.section &&
              item.section !== navigation[index - 1]?.section;
            return (
              <Fragment key={`${item.href}-${item.label}`}>
                {showSection ? (
                  <span className="side-nav-section">{item.section}</span>
                ) : null}
                <Link
                  href={item.href}
                  className={
                    index === activeNavigationIndex ? 'is-active' : undefined
                  }
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon size={19} aria-hidden />
                  <span>{item.label}</span>
                </Link>
              </Fragment>
            );
          })}
        </nav>
        <div className="side-nav-user">
          <span className="avatar" aria-hidden>
            {user.displayName.slice(0, 1)}
          </span>
          <span className="side-nav-user-copy">
            <strong>{user.displayName}</strong>
            <small>
              {primaryRole === 'DEVELOPER' && navigationRole !== 'DEVELOPER'
                ? `开发者 · ${roleLabels[navigationRole]}视角`
                : roleLabels[navigationRole]}
            </small>
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="退出登录"
            onClick={() => void logout()}
          >
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </aside>

      {menuOpen ? (
        <button
          className="nav-backdrop"
          type="button"
          aria-label="关闭导航"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <div className="app-content">
        <header className="top-status-bar">
          <button
            className="icon-button mobile-menu-button"
            type="button"
            aria-label="打开导航"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={21} aria-hidden />
          </button>
          <div className="top-status-title">
            <strong>{roleLabels[navigationRole]}工作台</strong>
            <span className="connection-state">
              <i aria-hidden />
              系统在线
            </span>
          </div>
          <div className="top-status-actions">
            {primaryRole === 'DEVELOPER' ? (
              <label className="developer-role-preview">
                <ShieldCheck size={16} aria-hidden />
                <span>{isDeveloperPreview ? '临时预览' : '开发者全功能'}</span>
                <select
                  aria-label="切换角色视角"
                  value={previewRole}
                  onChange={(event) => {
                    const nextRole = event.target.value as PersonRole;
                    setPreviewRole(nextRole);
                    window.sessionStorage.setItem(
                      previewRoleStorageKey,
                      nextRole
                    );
                    router.push(navigationByRole[nextRole][0]?.href ?? '/management');
                  }}
                >
                  {rolePriority.map((role) => (
                    <option key={role} value={role}>
                      {roleLabels[role]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {dataUpdated ? (
              <button
                className="data-updated"
                type="button"
                onClick={() => {
                  setDataUpdated(false);
                  window.location.reload();
                }}
              >
                数据已更新，点击刷新
              </button>
            ) : null}
            {!['TALENT', 'DIRECTOR'].includes(navigationRole) ? (
              <Link
                href="/notifications"
                className="icon-button"
                aria-label="通知中心"
              >
                <Bell size={19} aria-hidden />
              </Link>
            ) : null}
          </div>
        </header>
        <div className="app-page-content">
          {accessDenied ? (
            <main className="page auth-gate-page">
              <section className="card auth-gate">
                <span className="status danger">无排班管理权限</span>
                <h1>当前角色不能进入排班管理</h1>
                <p>
                  主管、系统管理员和开发者可以编排；主播、场控和化妆师只能查看本人排班，达人和编导只能查看化妆师可预约时间。
                </p>
                <Link className="button" href={navigation[0]?.href ?? '/'}>
                  返回当前角色工作台
                </Link>
              </section>
            </main>
          ) : (
            children
          )}
        </div>
      </div>

      <nav className="bottom-nav" aria-label="移动端导航">
        {mobileNavigation.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href.split('#')[0];
          return (
            <Link
              key={`${item.href}-${item.label}-mobile`}
              href={item.href}
              className={active ? 'is-active' : undefined}
            >
              <Icon size={19} aria-hidden />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
