# 飞书正式排班集成说明

更新日期：2026-08-03

## 1. 当前数据主从关系

系统采用 `FEISHU_SCHEDULE_LOCAL_APPOINTMENTS` 混合权威模式：

- `直播部门排班表`：飞书为主，单向同步到 `staff_daily_schedules`；
- `主播直播排班表`：飞书为主，单向同步到 `live_slot_schedules`，随后合并为连续 `live_sessions`；
- 妆造预约、预约状态、冲突锁、风险、通知和审计：PostgreSQL 本地数据库为主；
- `化妆师预约表`：双向预约同步；程序写入通过 Outbox，飞书人工变更必须先经过本地冲突和状态校验；
- 月度自动排班：仅为辅助草案，不能发布覆盖飞书正式排班。

迁移 `021_feishu_schedule_authority.sql` 建立混合数据权威；后续迁移补齐预约写回、冲突去重、会话撤销和映射运行状态。历史 `LOCAL`、`LOCAL_OVERRIDE` 和 `AUTO_PLAN` 数据不删除，但不会覆盖飞书正式排班。

## 2. 业务映射

| 业务表 | 方向 | 用途 |
| --- | --- | --- |
| 直播部门排班表 | 飞书 → 程序 | 人员日排班、班次和在岗判断 |
| 主播直播排班表 | 飞书 → 程序 | 直播小时明细和连续场次 |
| 化妆师预约表 | 双向 | 预约、开始、完成、取消和异常状态 |

映射使用 Table ID 和 Field ID，不依赖中文字段名硬编码。真实 ID 属于部署配置，不进入公开仓库；View ID 仅可作为可选筛选条件，不能代替整表同步。

## 3. 同步入口

- 正式排班页 `/schedule`：主管、管理员和开发者可以点击“从飞书同步排班”；
- 数据源页 `/admin/feishu`：管理员和开发者可以测试连接、查看映射并立即同步；
- 自动同步：`FEISHU_SYNC_ENABLED=true` 时，按 `FEISHU_SYNC_INTERVAL_MINUTES` 定时补偿；
- Webhook：验证来源并按事件 ID 幂等处理，业务写入仍需经过本地校验；
- 同步记录：`/admin/sync`。

同步使用外部记录 ID 和内容哈希保证幂等。单条解析失败会记录冲突并继续其他记录；同步不清空本地数据库，也不会触碰本地预约。

## 4. 环境变量

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_BASE_APP_TOKEN=
FEISHU_SYNC_ENABLED=true
FEISHU_SYNC_INTERVAL_MINUTES=5
FEISHU_WEBHOOK_VERIFICATION_TOKEN=
```

所有凭据只保存在后端环境变量中，不得进入 `NEXT_PUBLIC_*`、前端代码或日志。

## 5. 验收边界

- 表格读取、字段映射、Outbox 入库、真实写回和群消息送达是不同验收层，不能互相替代。
- 生产上线前必须确认正式排班冲突为 0、预约表必填映射无缺失、Outbox 无持续失败。
- 不得为了验收向正式多维表格擅自制造测试记录；记录级写回应使用经业务授权的预约。
- 群机器人消息送达是独立外部验收项，不影响本地预约事务，但未验收前不能标记为“群通知已上线”。
