'use client';

import {
  CalendarClock,
  LockKeyhole,
  LogIn,
  ShieldCheck,
  Sparkles,
  UserRound
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { AlertBanner } from '@/components/business-ui';
import { api } from '@/lib/api';

interface AuthStatus {
  mode: 'LOCAL';
  feishuLoginEnabled: boolean;
  feishuIntegrationConfigured: boolean;
}

interface LoginResult {
  displayName: string;
  roles: string[];
  landingPath: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api<AuthStatus>('/auth/status').then(setStatus).catch((reason: Error) => {
      setError(reason.message);
    });
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api<LoginResult>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password })
      });
      router.replace(result.landingPath);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page login-page">
      <section className="card login-shell">
        <div className="login-intro">
          <p className="eyebrow">JISHI LIVE OPERATIONS</p>
          <h1 className="title">直播排班与妆造协同</h1>
          <p className="muted">
            使用系统账号进入。主播、达人、编导、化妆师和场控登录后会自动进入各自工作台，只能查看授权范围内的数据。
          </p>
          <div className="login-feature-list">
            {[
              [CalendarClock, '正式排班同步飞书', '无需飞书登录，排班员维护表格后系统同步'],
              [Sparkles, '角色工作台自动区分', '每个人只处理自己的任务'],
              [ShieldCheck, '权限由后端强制校验', '修改网址也不能越权']
            ].map(([Icon, title, description]) => {
              const ItemIcon = Icon as typeof CalendarClock;
              return (
                <div key={String(title)}>
                  <ItemIcon color="var(--brand)" aria-hidden />
                  <div>
                    <strong>{String(title)}</strong>
                    <span>{String(description)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <div>
            <p className="eyebrow">SYSTEM ACCOUNT</p>
            <h2>系统账号登录</h2>
            <p className="muted">账号由管理员在“人员与权限”中创建。</p>
          </div>
          {error ? <AlertBanner tone="danger" title={error} /> : null}
          <label className="login-field">
            <span>登录账号</span>
            <span className="login-input">
              <UserRound size={18} aria-hidden />
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="请输入系统账号"
                required
              />
            </span>
          </label>
          <label className="login-field">
            <span>密码</span>
            <span className="login-input">
              <LockKeyhole size={18} aria-hidden />
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                minLength={8}
                required
              />
            </span>
          </label>
          <button
            className="button login-submit"
            disabled={submitting || !status}
            type="submit"
          >
            <LogIn size={18} aria-hidden />
            {submitting ? '正在登录…' : '登录工作台'}
          </button>
          <small className="login-note">
            飞书仅在后台同步排班和发送通知，不会再要求员工授权登录。
          </small>
        </form>
      </section>
    </main>
  );
}
