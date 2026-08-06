import Link from 'next/link';

export default function AccessPendingPage() {
  return (
    <main className="page" style={{ paddingTop: '15vh' }}>
      <section className="card empty">
        <span className="status warning">账号已登录 · 权限待配置</span>
        <h1 className="title" style={{ marginTop: '1rem' }}>
          当前账号还没有可用的系统角色
        </h1>
        <p className="muted">
          请联系管理员在“人员管理”中配置岗位、登录权限和直播间数据范围。系统不会仅凭姓名自动授予权限。
        </p>
        <Link className="button secondary" href="/">
          返回登录页
        </Link>
      </section>
    </main>
  );
}
