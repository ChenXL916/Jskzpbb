# 权限矩阵

更新日期：2026-08-03

权限由 `roles`、`permissions`、`role_permissions`、`user_role_bindings` 和 `user_data_scopes` 保存。旧 `person_roles` 继续兼容已有数据。API 全局守卫读取数据库权限并执行角色校验，资源接口继续按本人或直播间范围过滤。

| 能力 | 主播 | 化妆师 | 场控 | 直播主管 | 管理员/开发者 |
| --- | :---: | :---: | :---: | :---: | :---: |
| 查看本人排班 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 查看授权直播间业务看板 |  |  | ✓ | ✓ | ✓ |
| 查看综合排班管理 |  |  |  | ✓ | ✓ |
| 新增、调整、取消和发布排班 |  |  |  | ✓ | ✓ |
| 为本人创建预约 | ✓ |  |  |  | ✓ |
| 代主播预约 |  |  | ✓ | ✓ | ✓ |
| 修改/取消预约 | 本人 |  | 授权直播间 | ✓ | ✓ |
| 开始/完成妆造 |  | 本人任务 |  |  | 管理补录需另记原因 |
| 处理风险 |  | 异常上报 | 授权直播间 | ✓ | ✓ |
| 管理人员/权限 |  |  |  |  | ✓ |
| 管理班次/规则 |  |  |  |  | ✓ |
| 管理飞书/同步 |  |  |  |  | ✓ |
| 查看操作日志 |  |  |  | 部分 | ✓ |
| 生成、调整、校验和发布月度主播排班 |  |  |  | ✓ | ✓ |

数据范围类型：

- 本人：主播、化妆师的业务查询强制使用会话 `personId`。
- 指定直播间：场控使用 `user_data_scopes` 的 ROOM 记录。
- 全部：直播主管、管理员、开发者。

前端菜单隐藏不是权限证据；未登录管理 API 返回 401，错误角色返回 403，越权 roomId 会在 API 再次拒绝。

月度主播排班使用独立权限 `schedule.auto_generate`，只授予 `LIVE_SUPERVISOR`、`ADMIN` 和 `DEVELOPER`。接口生成草案、调整分配、校验和发布均在后端验证该权限。

## 达人和编导

达人 `TALENT`、编导 `DIRECTOR` 只授予以下三项权限：

- `makeup.availability.view`：查看化妆师公开状态和预计可约时段；
- `appointment.create`：为本人创建妆造预约；
- `appointment.view.self`：查看本人预约及预计妆造时间。

这两个角色不授予本人排班、综合排班、其他人员预约详情、人员管理、同步管理或系统设置权限。前端只生成“化妆师可预约”一个入口；该页面显示公开可约状态、预计时段及本人预约，后端所有预约查询仍以会话 `personId` 强制限定本人。

## 排班管理边界

- `LIVE_SUPERVISOR`、`ADMIN`、`DEVELOPER`：可进入 `/schedule`、`/schedule/plans`，并通过 `schedule.manage` 新增、调整、取消和发布排班。
- `ANCHOR`、`MAKEUP_ARTIST`、`FIELD_CONTROL`：只能进入 `/my-schedule`，接口 `/me/schedule` 强制使用当前会话 `personId`，页面没有编辑、批量调整或发布入口。
- `TALENT`、`DIRECTOR`：不能进入综合排班或本人排班接口，只能进入化妆师可预约页面。
- 即使手工修改网址，综合排班和排班编辑接口仍会由后端角色守卫返回 403，不能依靠前端隐藏菜单绕过。
- 迁移 `020_schedule_role_boundaries.sql` 已显式撤销普通业务角色的 `schedule.manage`、`schedule.view.all` 和 `schedule.view.room`，避免历史授权残留。
