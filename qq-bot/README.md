# Linkualog QQ Bot

`qq-bot/` 是 Linkualog 的可选 QQ 机器人入口。它连接 QQ 机器人网关，把聊天中的加词、上传、任务处理和复习命令转发给 `master-server`。
KnoTodo 命令也合并在这个 bot 中，不再单独部署第二个 bot。

## 功能

- 单聊和群聊 `@机器人` 触发
- `\add` 添加词条
- `\upload` 收集图片/PDF
- `\process` 处理上传任务
- `\task` 查看任务状态
- `\review` 进入复习
- `\todo` 查看或添加 KnoTodo 待办
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

本机运行时默认连接 `http://127.0.0.1:8080`；Docker 部署时 Compose 会设置为容器内的 `http://master-server:18081`。如需覆盖：

- `QQ_LINKUALOG_BASE_URL`
- `QQ_LINKUALOG_DATA_DIR`
- `QQ_KNOTODO_BASE_URL`
- `QQ_KNOTODO_PUBLIC_URL`
- `QQ_LOCAL_DATA_DIR`
- `QQ_LINKUALOG_ENV_FILE`

QQ bot 复用 `MASTER_SERVER_LLM_PROVIDER` 时，现在也支持直接填写 Base URL，例如 `https://api.openai.com/v1`，运行时会自动补全 `/chat/completions`。

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

使用仓库根目录的唯一部署入口：

```bash
cd /path/to/linkualog
./deploy.sh
```

它会通过 `docker-compose.yml` 启动：

- `master-server`
- `knotodo`
- `qq-bot`

查看状态和日志：

```bash
docker compose -f docker-compose.yml --profile qq-bot ps
docker compose -f docker-compose.yml --profile qq-bot logs -f qq-bot
```

如果当前用户没有 Docker 权限，可以按环境改用 `sudo docker compose ...`。

## 数据

- 词条数据在仓库根目录 `data/vocabulary/`
- KnoTodo 数据在仓库根目录 `data/knotodo/`
- bot 会把会话状态写入 `qq-bot/local_data/`
- Docker 中 `data/vocabulary/` 以只读方式挂载给 bot
