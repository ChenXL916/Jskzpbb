# 数据库结构说明

更新日期：2026-08-01

## 本地数据权威迁移

迁移 `017_local_database_authority.sql` 完成：

- `system_settings` 写入不可变配置 `schedule.data_authority=LOCAL_DATABASE`；
- 全部 `feishu_table_mappings.enabled=false`；
- 遗留 `PENDING`、`FAILED`、`RUNNING` 飞书表格写回任务改为 `CANCELLED`；
- 有效预约冲突约束排除 `source_type='FEISHU'` 历史镜像；
- 为 `LOCAL`、`LOCAL_OVERRIDE`、`AUTO_PLAN` 排班查询增加部分索引。

业务查询必须显式限定本地来源；不得把历史 `FEISHU` 记录重新加入月工时、可用性、预约冲突或排班页面。

项目使用 PostgreSQL 16 和原生 `pg`。所有结构变更位于 `apps/api/src/database/migrations`，迁移器使用 advisory lock 和校验和，禁止修改已应用迁移。

## 1. 核心表

| 领域 | 表 |
| --- | --- |
| 人员与认证 | `people`、`users`、`person_roles` |
| RBAC | `roles`、`permissions`、`role_permissions`、`user_role_bindings`、`user_data_scopes` |
| 直播间与班次 | `rooms`、`shift_templates`、`shift_template_aliases`、`staff_daily_schedules`、`staff_schedule_segments` |
| 直播排班 | `live_slot_schedules`、`live_sessions`、`room_field_controls` |
| 妆造 | `makeup_service_types`、`makeup_artist_availability`、`person_temporary_statuses`、`makeup_appointments`、`appointment_status_logs`、`appointment_exceptions` |
| 风险与通知 | `risk_items`、`notifications`、`notification_outbox` |
| 飞书与同步 | `feishu_connections`、`feishu_table_mappings`、`feishu_field_mappings`、`external_record_mappings`、`sync_jobs`、`sync_job_items`、`sync_conflicts`、`webhook_events`、`feishu_write_outbox` |
| 配置与审计 | `system_settings`、`operation_logs`、`idempotency_keys` |
| 主播自动排班 | `anchor_performance_scores`、`monthly_schedule_plans`、`monthly_schedule_slots`、`monthly_schedule_assignments`、`schedule_plan_violations` |

## 2. 新增迁移

- `006_expand_appointment_status.sql`：补充 `DRAFT`、`RESCHEDULE_REQUIRED`、`REASSIGN_REQUIRED`、`EXCEPTION`。
- `007_product_core_refactor.sql`：可配置 RBAC、班次别名、异常、临时状态、风险、同步明细、站内通知和系统设置。
- `008_notification_idempotency.sql`：站内通知幂等键。
- `009_local_account_auth.sql`：本地账号、密码摘要、失败锁定和认证来源。
- `010_schedule_operations.sql`：排班来源与版本、人工覆盖、取消时间、直播场次关联场控和 `schedule.manage` 权限。
- `011_schedule_group_notifications.sql`：排班提醒、发布和预约成功群通知规则及可靠 Outbox。
- `012_add_requester_roles.sql`：增加达人 `TALENT`、编导 `DIRECTOR` 人员角色。
- `013_general_makeup_requesters_and_refined_shifts.sql`：增加通用妆造对象、达人/编导最小权限，并细化培训班、行政班、自由 7 小时和自由 4 小时模板。
- `014_anchor_auto_scheduling.sql`：增加按直播间版本化的主播能力档案、月度排班草案、需求时段、分配、违规记录、主播用工类型回填及 `schedule.auto_generate` 权限。
- `015_anchor_performance_evidence.sql`：补充公平诊断中的校正 ROI、校正时均成交、证据状态和源文件 SHA-256。
- `016_monthly_schedule_automation.sql`：增加每月自动草案开关、执行日、执行时间及提前月份配置；默认每月 20 日 10:00 生成下个月草案。

迁移已在当前本地 PostgreSQL 应用成功。

## 3. 一致性约束

- `people.employee_no`、飞书 User ID、Open ID 条件唯一。
- 外部记录按来源系统、表 ID、记录 ID 唯一映射。
- 单场直播的同一主播只能存在一条占用中的有效预约。
- `makeup_appointments.subject_person_id` 与 `subject_type` 保存通用妆造对象；历史主播预约自动回填，独立达人/编导预约不要求绑定直播场次或直播间。
- PostgreSQL GiST 排斥约束禁止同一化妆师在有效状态下出现重叠 `[start,end)`。
- 占用状态包括 `BOOKED`、`IN_PROGRESS`、`RESCHEDULE_REQUIRED`、`REASSIGN_REQUIRED`、`EXCEPTION`。
- 预约使用 `version` 乐观锁，关键写入使用事务级资源锁。
- 直播场次按直播间、主播、场控资源使用事务级 advisory lock 和半开区间冲突校验。
- 飞书排班被人工调整后标记 `LOCAL_OVERRIDE`，增量同步不覆盖本地调整版本。
- 有历史数据的人员由 `archived_at` 保留，不级联物理删除业务历史。
- 草案内同一主播的重叠时段由 GiST 排斥约束阻止；单个需求块数据库层限制不超过 5 小时。
- 草案发布使用稳定 `AUTO:<assignment_id>` 指纹幂等写入 `live_sessions`，重复发布不会重复创建正式场次。
- 定时生成在同月 advisory lock 内检查活动草案和已发布计划；存在 `DRAFT`、`VALIDATED` 或 `PUBLISHED` 时不会重复创建。

## 4. 审查快照

2026-07-31 本地环境：56 人、1 个绑定用户、681 条人员日排班、1880 条直播小时明细、695 个连续直播班次、0 条正式预约、15 个同步任务、133 条同步冲突、3 条开放风险。

该快照只说明当前集成环境，不是生产统计；0 条预约意味着真实预约全生命周期尚未验收。
