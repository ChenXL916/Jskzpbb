export default function GatewayFallback() {
  return (
    <main className="shell">
      <section className="card" role="status">
        <span className="mark">妆</span>
        <p className="kicker">JISHI OPERATIONS</p>
        <h1>排班与妆造协同系统正在连接</h1>
        <p>本机业务服务暂时不可达。系统不会展示旧数据或模拟数据，请稍后刷新。</p>
        <a href="/">刷新重试</a>
      </section>
    </main>
  );
}
