# Sites 隔离上线说明

## 目的

妆造系统使用独立 Sites 固定入口和 Cloudflare Quick Tunnel，不复用、不修改“多直播间小时数据驾驶舱”的站点、端口、进程、数据库、Redis、日志或 Windows 任务。

## 运行拓扑

```text
Sites 固定入口
  -> Sites Worker
  -> GitHub makeup-runtime/runtime/backend-origin.json
  -> 独立 Cloudflare Quick Tunnel
  -> Next.js 127.0.0.1:8088
       -> /api/* 同源转发到 NestJS 127.0.0.1:3002
            -> PostgreSQL 127.0.0.1:5432
            -> Redis 127.0.0.1:6380
            -> MinIO 127.0.0.1:9000
```

多直播间驾驶舱继续使用 `8000/6379`、`LiveOps-Gateway` 和自己的运行分支。妆造系统使用 `8088/3002/5432/6380`、`MakeupOps-Gateway` 和 `makeup-runtime` 分支。

## 自动恢复

`MakeupOps-Gateway` 在当前 Windows 用户登录后启动：

1. 唤醒 WSL 和妆造系统三个基础设施容器；
2. 检查并恢复 API 和 Web；
3. 创建仅指向 `127.0.0.1:8088` 的 Quick Tunnel；
4. 将唯一公开信息 `origin` 写入 `makeup-runtime` 分支；
5. Sites Worker 每 15 秒刷新一次运行地址缓存；
6. 隧道退出后自动重建，不向运行分支写入任何密钥、Cookie、飞书凭据或业务数据。

## 可用性边界

这是零服务器费用的内部试运行方案。电脑关机、Windows 用户未登录或本地网络持续中断时，系统无法提供 24×7 服务。Sites 固定入口不会展示旧数据或模拟数据，后端不可达时明确返回恢复提示。

## 安全边界

- Sites 与 Quick Tunnel 只暴露网页入口；PostgreSQL、Redis、MinIO 不开放公网端口。
- 正式入口使用 HTTPS，同源 `/api` 保留 Cookie 和权限校验。
- App Secret、机器人 Webhook、数据库密码只保存在被 Git 忽略的 `.env`。
- Sites 项目、运行分支和 Windows 任务均与多直播间驾驶舱隔离。
