# Linkualog QQ Bot

`qq-bot/` 是 Linkualog 的可选 QQ 机器人入口。它连接 QQ 机器人网关，把聊天中的加词、上传、任务处理和复习命令转发给 `master-server`。

## 功能

- 单聊和群聊 `@机器人` 触发
- `\add` 添加词条
- `\upload` 收集图片/PDF
- `\process` 处理上传任务
- `\task` 查看任务状态
- `\review` 进入复习
- `\search` 查词
- `\status` 查看当前状态

发送 `\help` 可以查看完整命令。

## 配置

QQ bot 复用仓库根目录 `.env`：

```bash
cd /path/to/linkualog
cp .env.example .env
# 填写 MASTER_SERVER_LLM_API_KEY、QQ_APP_ID、QQ_APP_SECRET
```

必填：

- `QQ_APP_ID`
- `QQ_APP_SECRET`

本机运行时默认连接 `http://127.0.0.1:8080`。如需覆盖：

- `QQ_LINKUALOG_BASE_URL`
- `QQ_LINKUALOG_DATA_DIR`
- `QQ_LOCAL_DATA_DIR`
- `QQ_LINKUALOG_ENV_FILE`

## 本地运行

先启动 `master-server`：

```bash
cd /path/to/linkualog/master-server
uv sync
uv run main.py
```

再启动 QQ bot：

```bash
cd /path/to/linkualog/qq-bot
uv sync
uv run main.py
```

## Docker 运行

推荐使用仓库根目录的 `deploy.sh`：

```bash
cd /path/to/linkualog
./deploy.sh
```

它会通过 `docker compose --profile qq-bot up -d --build` 启动：

- `master-server`
- `qq-bot`

查看状态和日志：

```bash
docker compose --profile qq-bot ps
docker compose --profile qq-bot logs -f qq-bot
```

如果当前用户没有 Docker 权限，可以按环境改用 `sudo docker compose ...`。

## 数据

- 词条数据仍在仓库根目录 `data/`
- bot 会把会话状态写入 `qq-bot/local_data/`
- Docker 中 `data/` 以只读方式挂载给 bot
