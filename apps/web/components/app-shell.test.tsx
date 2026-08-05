import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { AppShell, navigationByRole } from './app-shell';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn()
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    API_URL: 'http://localhost:3002/api',
    api: apiMock
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/today',
  useRouter: () => ({
    replace: vi.fn(),
    refresh: vi.fn()
  })
}));

describe('AppShell authentication gate', () => {
  beforeEach(() => {
    apiMock.mockReset();
    window.sessionStorage.clear();
  });

  it('shows a local account entry when the session is missing', async () => {
    apiMock.mockRejectedValue(new ApiError('请先使用系统账号登录', 401));

    const { unmount } = render(
      <AppShell>
        <div>受保护内容</div>
      </AppShell>
    );

    const login = await screen.findByRole('link', {
      name: '账号密码登录'
    });
    expect(login).toHaveAttribute('href', '/');
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    unmount();
  });

  it('keeps the developer default navigation inside the unified management IA', () => {
    const routes = navigationByRole.DEVELOPER.map((item) => item.href);

    expect(routes).toEqual([
      '/management',
      '/schedule',
      '/schedule/plans',
      '/control',
      '/requester',
      '/makeup/tasks',
      '/appointments',
      '/risks',
      '/notifications',
      '/admin',
      '/admin/scheduling',
      '/admin/rules',
      '/admin/shifts',
      '/admin/notifications',
      '/admin/feishu',
      '/admin/sync',
      '/admin/logs',
      '/admin/settings'
    ]);
    expect(routes).toHaveLength(18);
    expect(navigationByRole.ADMIN.map((item) => item.href)).toEqual(routes);
  });

  it('restores the developer preview role after navigation remounts the shell', async () => {
    window.sessionStorage.setItem('jishi.developerPreviewRole.v2', 'ANCHOR');
    apiMock.mockResolvedValue({
      id: 'developer-user',
      personId: 'developer-person',
      displayName: '开发者',
      roles: ['DEVELOPER'],
      roomIds: []
    });

    const { unmount } = render(
      <AppShell>
        <div>主播视角内容</div>
      </AppShell>
    );

    expect(await screen.findAllByRole('link', { name: '今日' })).toHaveLength(2);
    expect(screen.getByLabelText('切换角色视角')).toHaveValue('ANCHOR');
    expect(
      screen.getByRole('button', { name: /返回开发者全部功能/ })
    ).toBeInTheDocument();
    unmount();
  });

  it('keeps talent and director navigation inside the requester scope', () => {
    for (const role of ['TALENT', 'DIRECTOR'] as const) {
      const routes = navigationByRole[role].map((item) => item.href);
      expect(routes).toEqual(['/requester']);
      expect(routes).not.toContain('/schedule');
      expect(routes).not.toContain('/admin');
    }
  });

  it('routes operational staff to a read-only personal schedule', () => {
    for (const role of ['ANCHOR', 'MAKEUP_ARTIST', 'FIELD_CONTROL'] as const) {
      const routes = navigationByRole[role].map((item) => item.href);
      expect(routes).toContain('/my-schedule');
      expect(routes).not.toContain('/schedule');
      expect(routes).not.toContain('/schedule/plans');
    }
  });

  it('shows automatic scheduling only to roles granted the backend permission', () => {
    for (const role of ['LIVE_SUPERVISOR', 'ADMIN', 'DEVELOPER'] as const) {
      expect(navigationByRole[role].map((item) => item.href)).toContain(
        '/schedule/plans'
      );
    }
    for (const role of [
      'ANCHOR',
      'TALENT',
      'DIRECTOR',
      'MAKEUP_ARTIST',
      'FIELD_CONTROL'
    ] as const) {
      expect(navigationByRole[role].map((item) => item.href)).not.toContain(
        '/schedule/plans'
      );
    }
  });
});
