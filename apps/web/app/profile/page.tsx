'use client';

import { CurrentUser, PersonRole } from '@jishi/contracts';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { PersonAvatar } from '@/components/business-ui';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';

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

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    void api<CurrentUser>('/auth/me').then(setUser);
  }, []);

  const logout = async () => {
    await api<void>('/auth/logout', { method: 'POST' });
    router.replace('/');
  };

  return (
    <AppShell>
      <main className="page operations-page">
        <header className="business-page-header">
          <div>
            <p className="eyebrow">PROFILE</p>
            <h1 className="title">我的身份</h1>
            <p className="muted">身份和数据范围由管理员绑定，不能通过修改页面参数切换。</p>
          </div>
        </header>
        {!user ? (
          <LoadingState />
        ) : (
          <section className="card profile-card">
            <PersonAvatar
              name={user.displayName}
              size="lg"
              {...(user.avatarUrl ? { src: user.avatarUrl } : {})}
            />
            <div>
              <h2>{user.displayName}</h2>
              <div className="role-chip-list">
                {user.roles.map((role) => (
                  <span key={role}>{roleLabels[role]}</span>
                ))}
              </div>
              <p className="muted">
                已授权 {user.roomIds.length} 个直播间 ·{' '}
                {user.permissions?.length ?? 0} 项功能权限
              </p>
            </div>
            <button className="button secondary" onClick={() => void logout()}>
              <LogOut size={17} aria-hidden />
              退出登录
            </button>
          </section>
        )}
      </main>
    </AppShell>
  );
}
