# 部署指南

更新日期：2026-08-05

## 1. 前置

- Node.js 22 或更高
- pnpm 10
- Docker Desktop；本机当前通过 WSL `Ubuntu-24.04` 使用 Docker
- 复制 `.env.example` 为 `.env`，生成强随机会话密钥和 32 字节 Base64 token 加密密钥

## 2. 本地构建

```powershell
pnpm.cmd install
pnpm.cmd db:migrate
pnpm.cmd run check
```

## 3. Docker Compose

当前 Windows Docker CLI 不在 PATH，使用：

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /mnt/e/妆造协同管理系统 && COMPOSE_BAKE=false DOCKER_BUILDKIT=0 docker compose -p jishi-scheduling build api web"
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /mnt/e/妆造协同管理系统 && docker compose -p jishi-scheduling up -d"
```

当前环境 BuildKit 曾因 Docker Desktop shared key 出现不可打印字符错误，关闭 BuildKit 的 classic builder 已验证可用；这是本机工具链问题，不是应用构建错误。

如果 Compose 仍因中文工作目录触发 shared key 错误，可在 WSL 建立 ASCII
临时软链接后构建（不复制、不修改项目数据）：

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "ln -sfn '/mnt/e/妆造协同管理系统' /tmp/jishi-scheduling-src && cd /tmp/jishi-scheduling-src && docker compose -p jishi-scheduling up -d --build"
```

入口：

- Web：`http://localhost:8088`
- API：`http://localhost:3002/api`
- 健康检查：`http://localhost:3002/api/health`

## 4. 首次上线

1. 备份 PostgreSQL；历史飞书镜像如需清理应另做归档，不直接删除。
2. 应用迁移，不修改历史迁移文件。
3. 确认 `schedule.data_authority=FEISHU_SCHEDULE_LOCAL_APPOINTMENTS`。
4. 配置并测试飞书正式人员排班、主播直播排班及妆造预约三类映射；密钥和真实 ID 只保存在服务端环境变量或后台安全配置中。
5. 用管理员账号登录并检查人员、角色、化妆师登录绑定和场控直播间数据范围。
6. 同步正式排班，确认解析失败为 0、正式排班冲突为 0；仅有时长而无开始时间的自由班必须人工确认。
7. 经业务授权创建一条预约，验证开始、完成、站内通知、审计日志及飞书预约表写回。
8. 如使用飞书群通知，配置机器人后验证排班提醒、排班发布和预约后 @化妆师的真实送达。

## 6. 排班群通知

三类群独立配置，Webhook 和 `chat_id` 二选一；同一群两者都配置时优先
Webhook：

```dotenv
FEISHU_SCHEDULING_GROUP_CHAT_ID=
FEISHU_SCHEDULING_GROUP_WEBHOOK_URL=
FEISHU_ANCHOR_GROUP_CHAT_ID=
FEISHU_ANCHOR_GROUP_WEBHOOK_URL=
FEISHU_MAKEUP_GROUP_CHAT_ID=
FEISHU_MAKEUP_GROUP_WEBHOOK_URL=
```

- Webhook 必须是飞书群内添加的自定义机器人地址；
- `chat_id` 模式要求应用已开启机器人能力、发布版本并加入目标群；
- 不得把 Webhook 放入前端代码或浏览器配置；
- 配置缺失时消息保留为 `WAITING_CONFIGURATION`，不会影响排班或预约事务；
- 配置完成并重启 API 后，可在“管理 → 排班通知”发送测试或重试历史消息。

默认规则：

| 规则 | 默认时间 | 目标 |
| --- | --- | --- |
| 排班开始提醒 | 每周四 17:00 | 排班负责人群 |
| 下周排班发布 | 每周六 18:00 | 主播群 |
| 妆造预约成功 | 预约成功后立即 | 化妆师群 |

首版 DDL：`2026-08-07 18:00 Asia/Shanghai`。

## 7. 智能月排班操作

1. 打开 `http://localhost:8088/schedule/plans`。
2. 选择月份、参与直播间、每日覆盖起止时间和 1—5 小时连续块；默认推荐 4 小时。
3. 选择已有排班处理策略：默认“保留已有排班”只补实际空档；需要重做已发布的系统自动排班时，选择“替换系统自动排班”。两种方式都只生成程序草案，不会立即取消旧正式排班。
4. 按日期和直播间逐时段换主播；每次保存后草案回到待校验状态。
5. 点击“重新校验”，处理全部硬错误；程序内明确休息、请假、不可排或解析失败会阻断对应时段。
6. 只有在业务确认后才点击“发布正式排班”。发布会在事务内重校验并写入 `AUTO_PLAN`；替换策略会同时软取消目标范围内的旧 `AUTO_PLAN`，但不会覆盖人工排班。旧场次有关联妆造预约或草案为空时发布会被阻止。
7. 月度方案在当前权威模式下仅用于分析和辅助调整，不得发布覆盖飞书正式排班；正式变更应在飞书源表完成后重新同步。

### 每月自动生成设置

1. 打开“排班中心 → 智能月排班”，展开“自动生成设置”。
2. 默认配置为每月 20 日 10:00（Asia/Shanghai）生成下个月草案；可设置每月 1—28 日、0—23 时、0—59 分及提前 1—3 个月。
3. 自动任务只生成草案。主管仍需检查业务规则、人工调整、重新校验并点击发布。
4. 同月已有活动草案或已发布计划时任务自动跳过；停机错过执行时间后，服务恢复会补跑。

两份能力报告更新时必须新建迁移或导入批次，保存报告周期、主播和直播间确认映射、原始指标及 SHA-256；禁止修改已应用的 `014`、`015`。

## 5. 回滚

数据库迁移采用前向修复。发布前必须创建 PostgreSQL 和飞书数据备份；出现问题时回滚应用镜像，保留新表数据，不执行破坏性 `DROP` 或清库。
