# 系统架构与数据模型

更新日期：2026-08-03

## 1. 运行架构

系统采用混合权威模式：飞书多维表格负责正式人员排班和主播小时排班，PostgreSQL 负责标准化镜像、预约事务、冲突、状态、通知、权限和审计。Next.js 前端只访问 NestJS API，不直接读取飞书或接触飞书密钥。

```text
飞书人员月排班 / 飞书主播小时排班
                  ↓
标准化人员班次 / 连续直播场次
                  ↓
本地妆造预约 + RBAC + Redis 短锁 + PostgreSQL 事务
                  ↓
主播端 / 化妆师端 / 场控端 / 主管端 / 管理端
                  ↓
站内通知 / SSE / 可选飞书机器人消息 Outbox
```

两张排班表启用 `FEISHU_TO_LOCAL` 同步；化妆预约表保持停用。月度自动排班只作辅助草案，正式业务查询只读取 `FEISHU` 排班记录。

## 2. 核心数据表

- 身份与权限：`people`、`person_roles`、`users`、`user_data_scopes`
- 直播间与班次：`rooms`、`shift_templates`、`staff_daily_schedules`
- 直播排班：`live_sessions`、`room_field_controls`、`monthly_schedule_plans`、`monthly_schedule_items`
- 妆造业务：`makeup_service_types`、`makeup_artist_availability`、`makeup_appointments`、`appointment_status_logs`
- 可靠任务：`notification_outbox`
- 审计与幂等：`operation_logs`、`idempotency_keys`
- 飞书同步：`feishu_connections`、`feishu_table_mappings`、`feishu_field_mappings`、`live_slot_schedules`、`external_record_mappings`、`sync_jobs`。

迁移 `021_feishu_schedule_authority.sql` 将数据权威切换为 `FEISHU_SCHEDULE_LOCAL_APPOINTMENTS`，只启用正式排班表并保持预约表停用。

## 3. 排班规则

- 正式排班有效来源为 `FEISHU`；本地历史和自动草案不作为正式排班。
- 单次连续直播不超过 5 小时；同日有间隔的多个场次分别计算。
- 跨日相邻直播间隔至少 8 小时。
- 全职主播月直播目标为 104—130 小时。
- 人工休息、请假、不可排和解析失败继续阻断对应时段。
- 飞书未录入或无法解析的人员班次不得用于预约，并在页面显示缺失或待确认。

## 4. 预约一致性

预约使用半开区间 `[start, end)`。确认时依次校验角色/数据范围、人员状态、化妆师班次与休息、时间冲突、开播缓冲、Redis 短锁、数据库 advisory lock 和 GiST 排斥约束。

预约、状态日志、站内通知和可选飞书机器人消息 Outbox 在本地事务内创建。任何飞书服务故障都不会回滚本地预约。

## 5. 权限边界

- 主播：仅本人直播和预约。
- 化妆师：仅本人班次与任务。
- 场控：仅授权直播间。
- 达人/编导：仅公开化妆师状态和本人预约。
- 主管：跨授权直播间。
- 管理员/开发者：人员、权限、排班、规则、通知和审计。

真正权限判断位于 NestJS 全局守卫和资源级查询条件，不能通过修改 URL 或参数绕过。
