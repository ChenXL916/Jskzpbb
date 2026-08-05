# 飞书配置

更新日期：2026-08-05

当前数据权威为 `FEISHU_SCHEDULE_LOCAL_APPOINTMENTS`：飞书多维表格负责正式人员排班和主播直播排班，PostgreSQL 负责妆造预约、状态、冲突、权限、通知和审计。预约变化通过可靠 Outbox 写回飞书预约表。

部署时需要在 API 的私有环境变量中配置 App ID、App Secret、Base App Token、三张业务表 ID 及可选群通知目标。Field ID 由管理后台读取元数据并保存，不应写死在前端。

安全要求：App Secret、Token、Webhook、数据库密码和真实 Table ID 不得提交到 Git、进入前端代码、截图、日志或 `NEXT_PUBLIC_*`。当前仓库只保留占位配置。

详细的数据主从关系、环境变量和验收边界见 [飞书正式排班集成说明](feishu-integration.md)。
