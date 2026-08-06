# 吉拾开张直播部门排班与妆造协同系统

面向主播、化妆师、场控、直播主管和管理员的排班协同系统。系统采用混合数据权威：飞书多维表格负责正式人员排班和主播直播排班，PostgreSQL 负责预约事务、冲突、状态、权限、通知和审计；妆造预约状态通过可靠 Outbox 写回飞书。

## 技术栈

- Next.js + React + TypeScript
- NestJS + TypeScript
- PostgreSQL 16（预约区间排斥约束）
- Redis（短时预约锁、任务队列）
- 系统账号密码登录、RBAC 与数据范围权限
- 飞书开放平台（正式排班读取、预约写回和可选群通知）
- MinIO/S3（附件）

## 本地启动

1. 复制 `.env.example` 为 `.env` 并填写安全配置。
2. 执行 `make.cmd install`。
3. 执行 `make.cmd infra`。
4. 执行 `make.cmd migrate`。
5. 执行 `make.cmd dev`。

Web 默认地址：<http://localhost:8088>，API：<http://localhost:3002/api>。

员工不需要飞书授权，管理员在“人员与权限”中创建系统账号。没有配置飞书机器人时，本地登录、预约和站内通知仍可运行；正式排班仍以飞书表格为准。

## 容器启动

执行 `make.cmd up` 后访问：

- Web：<http://localhost:8088>
- API 健康检查：<http://localhost:3002/api/health>
- MinIO 控制台：<http://localhost:9001>

## 排班提醒与群通知

管理员或开发者可进入
`http://localhost:8088/admin/notifications` 管理：

- 每周四 17:00 提醒排班负责人开始排下周班次；
- 每周六 18:00 把下周直播排班汇总发到主播群；
- 妆造预约成功后，把预约主播、化妆师、妆造时间、上播时间和直播间发到化妆师群。

群通知采用数据库 Outbox，具备幂等、失败重试和“等待机器人配置”状态。
三类群可分别配置飞书自定义机器人 Webhook 或应用机器人 `chat_id`，
配置项见 `.env.example`。首版 DDL 为 **2026-08-07 18:00**，自动规则从该时间后生效。

## 项目文档

- [架构与数据模型](docs/ARCHITECTURE.md)
- [飞书边界与群通知](docs/feishu-integration.md)
- [部署指南](docs/deployment-guide.md)
- [当前开发进度](docs/PROGRESS.md)
