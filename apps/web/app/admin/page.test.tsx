import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from './page';

const apiMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  formatDateTime: () => '8月5日 10:00'
}));

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

describe('AdminPage people management', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      if (path === '/admin/people') {
        return Promise.resolve([
          {
            id: '11111111-1111-4111-8111-111111111111',
            display_name: '主播甲',
            employee_no: 'A001',
            has_local_password: false,
            employment_status: 'ACTIVE',
            login_allowed: true,
            booking_allowed: true,
            roles: ['ANCHOR'],
            room_ids: []
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            display_name: '化妆师乙',
            employee_no: 'M001',
            feishu_open_id: 'ou_artist',
            has_local_password: false,
            employment_status: 'ACTIVE',
            login_allowed: true,
            booking_allowed: true,
            roles: ['MAKEUP_ARTIST'],
            room_ids: []
          }
        ]);
      }
      if (path === '/admin/rooms' || path === '/admin/roles') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
  });

  it('filters people by role and exposes the add-person workflow', async () => {
    render(<AdminPage />);

    await screen.findByText('主播甲');
    expect(screen.getByText('化妆师乙')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('岗位筛选'), {
      target: { value: 'MAKEUP_ARTIST' }
    });
    expect(screen.queryByText('主播甲')).not.toBeInTheDocument();
    expect(screen.getByText('化妆师乙')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加人员' }));
    expect(
      screen.getByRole('heading', { name: '添加人员' })
    ).toBeInTheDocument();
    expect(screen.getByText('飞书 Open ID（选填）')).toBeInTheDocument();

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
  });
});
