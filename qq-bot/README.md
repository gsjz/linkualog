# Linkualog QQ Bot

`qq-bot/` 是 `linkualog` 正式仓库内的 QQ 机器人 connector。

它负责：

- 连接 QQ 机器人网关
- 接收单聊和群里 `@机器人` 事件
- 将 `\add`、`\upload`、`\review`、`\task`、`\process` 等指令路由到 `master-server`
- 对 `\help` 使用 QQ markdown 消息，便于在客户端分行展示
- `\task` 空参数会列出最近任务，避免手动查任务 ID
- `\upload [任务名]` 支持命名任务，上传模式中可用 `\name` 修改名称
- `\auto on|off` 可在上传模式中开关上传后自动分析，默认开启
- 复用仓库根目录 `.env` 里的 `MASTER_SERVER_LLM_*` 配置

## 目录文件

- `main.py`: QQ 网关客户端、会话状态机、Linkualog API connector
- `pyproject.toml` / `uv.lock`: `uv` 管理的 Python 依赖
- `Dockerfile`: QQ bot 容器镜像
- `.env.local.example`: 本机 `uv` 运行模板

## 本机运行

先在仓库根目录准备 `.env`，然后按下面顺序启动：

```bash
cd /home/ubuntu/linkualog/master-server
uv sync
uv run main.py
```

```bash
cd /home/ubuntu/linkualog/qq-bot
cp .env.local.example .env.local
uv sync
uv run main.py
```

## Docker 部署

Docker 部署入口不在本目录，而在仓库根目录：

```bash
cd /home/ubuntu/linkualog
cp .env.example .env
# 填入 MASTER_SERVER_LLM_API_KEY、QQ_APP_ID、QQ_APP_SECRET

./deploy.sh
```

根目录 `deploy.sh` 会通过 `docker compose --profile qq-bot up -d --build` 一次启动：

- `master-server`
- `qq-bot`

## 主要环境变量

- `QQ_APP_ID`
- `QQ_APP_SECRET`
- `QQ_INTENTS`
- `QQ_SHARD_ID`
- `QQ_SHARD_COUNT`
- `QQ_RUN_SECONDS`
- `QQ_LLM_ROUTE_ENABLED`
- `QQ_LLM_ROUTE_CONFIDENCE`
- `QQ_ADD_FETCH_LLM`
- `QQ_LINKUALOG_BASE_URL`
- `QQ_LINKUALOG_DATA_DIR`
- `QQ_LOCAL_DATA_DIR`
- `QQ_SESSION_STATE_FILE`

本机 `uv` 运行时，这些变量默认优先从 `qq-bot/.env.local` 读取，再回退到仓库根目录 `.env`。

## 当前验证范围

截至 2026-04-19，这个 connector 已完成：

- `Access Token` 获取成功
- `/gateway/bot` 获取成功
- `Hello / Identify / READY` 成功
- 心跳与 `Heartbeat ACK` 成功
- 单聊消息被动回复跑通
- `\upload -> \process -> \task` 图片 OCR 联调跑通
- `\upload PDF -> \process -> \task` PDF OCR 联调跑通

## 日志与状态

```bash
cd /home/ubuntu/linkualog
sudo -n docker compose --profile qq-bot logs -f qq-bot
sudo -n docker compose --profile qq-bot ps
```
