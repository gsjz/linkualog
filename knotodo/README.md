# knotodo

`knotodo` 是 Linkualog 仓库内的轻量 calendar / todo / kanban 组件。后端使用 FastAPI，前端使用 React + Vite，数据持久化到仓库根目录 `data/knotodo/`。

## 功能

- 月历总览与日视图
- Todo、时间块、截止事项
- 模板与搜索
- 轻量看板（board / lane / card）
- 本地 JSON 持久化与备份

## 技术栈

- 后端：FastAPI、Pydantic、filelock
- 前端：React 19、Vite
- 运行时：Python 3.13、Node.js 20
- 部署：由仓库根目录 Docker Compose 统一管理

## 本地开发

```bash
uv sync
npm --prefix frontend ci
uv run main.py
```

默认会启动：

- 前端开发服务：`http://127.0.0.1:4173`
- 后端 API：`http://127.0.0.1:8081`
- 健康检查：`http://127.0.0.1:8081/api/health`

说明：

- 本地开发默认由 `main.py` 同时拉起 FastAPI 和 Vite。
- 生产部署默认关闭 Vite，并由 FastAPI 直接托管 `frontend/dist`。

## Docker 部署

```bash
cd /path/to/linkualog
make rebuild-knotodo
```

默认入口：

- 本机反代端口：`http://127.0.0.1:18082/todo`
- 健康检查：`/todo/api/health`

## 反向代理部署

如果希望由 Nginx 接管 `80/443`，使用根目录部署脚本启动服务：

```bash
cd /path/to/linkualog
./deploy.sh knotodo
```

仓库根目录附带了通用示例配置：[../deploy/nginx/linkualog.example.conf](../deploy/nginx/linkualog.example.conf)。它把同一个域名的 `/todo` 代理到 KnoTodo，例如 `https://log.shujie.cc/todo`。

默认映射：

- `/todo -> 127.0.0.1:18082`
- 容器内 FastAPI 端口：`18083`

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KNOTODO_BACKEND_PORT` | `8081` | FastAPI 实际监听端口；Docker 部署设置为 `18083` |
| `KNOTODO_BASE_PATH` | 空 | 容器部署设置为 `/todo` |
| `KNOTODO_UID` / `KNOTODO_GID` | `1000` | 容器写入 `data/knotodo/` 时使用的用户 |
| `KNOTODO_LOG_LEVEL` | `INFO` | 日志级别 |
| `KNOTODO_SERVE_BUILT_FRONTEND` | `0` | 是否由 FastAPI 托管 `frontend/dist` |
| `KNOTODO_DISABLE_FRONTEND` | `0` | 是否禁用本地 Vite 开发服务 |
| `KNOTODO_DB_FILE` | 自动推导 | JSON 数据文件路径 |
| `KNOTODO_LOCK_FILE` | 自动推导 | 文件锁路径 |
| `KNOTODO_DB_BACKUP_FILE` | 自动推导 | 备份文件路径 |
| `KNOTODO_LOCK_TIMEOUT` | `10` | 文件锁超时时间（秒） |

容器部署会强制启用内置静态资源托管，部署参数以仓库根目录 Compose 文件为准。

## 项目结构

```text
knotodo/
├── api/                    # FastAPI 路由、请求模型、错误映射
├── core/                   # 日历 / todo / 看板核心逻辑与存储
├── frontend/               # React + Vite 前端
├── utils/                  # 运行辅助逻辑
├── main.py                 # 应用入口
└── local_data/             # 本地开发运行期生成，不纳入版本控制
```

## 版本控制约定

建议提交：

- 源代码、部署配置、示例环境文件
- `uv.lock`
- `frontend/package-lock.json`

不要提交：

- `.env`
- `local_data/` 下的本地开发运行数据
- 根目录 `data/knotodo/` 下的运行数据
- `frontend/node_modules/`、`frontend/dist/`
- 服务器私有部署文件（例如本机域名专用 Nginx 配置）
- `.venv/`、`__pycache__/`、编辑器配置、日志文件

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
