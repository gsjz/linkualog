# master-server

统一后的 `master-server` 只有一套 FastAPI 后端和一套 React 前端：

- `frontend/`：主前端，包含 `OCR 解析库`、`我的生词本`、`精修与复习`
- `main.py`：统一入口
- Docker / Compose：构建阶段打包前端，运行时由 FastAPI 同端口托管

## 配置

默认配置来自仓库根目录的 `.env`，参考仓库根目录 `.env.example`。

最常用的变量只有这些：

- `MASTER_SERVER_LLM_PROVIDER`
- `MASTER_SERVER_LLM_MODEL`
- `MASTER_SERVER_LLM_API_KEY`
- `MASTER_SERVER_FRONTEND_PORT`
- `MASTER_SERVER_BACKEND_PORT`

Docker 构建镜像源也支持通过 `.env` 调整：

- `MASTER_SERVER_APT_MIRROR_BASE`
- `MASTER_SERVER_PIP_INDEX_URL`
- `MASTER_SERVER_NPM_REGISTRY`

高级 review / merge 调参没有放进 `.env.example`。通常直接用前端“全局配置”或 `master-server/local_data/llm_config.json` 即可。

配置优先级：

1. 仓库根目录 `.env`
2. `master-server/local_data/llm_config.json`
3. 代码内置默认值

## 本地手动部署

推荐环境：

- Python `3.13`
- `uv`
- Node.js `20`
- `npm`
- `poppler-utils`（本地要处理 PDF 时需要）

步骤：

```bash
cd /path/to/linkualog
cp .env.example .env
# 编辑 .env，至少填入 MASTER_SERVER_LLM_API_KEY

cd master-server
uv sync
uv run main.py
```

如果你之前用 root 或 Docker 在宿主机写过 `master-server/local_data/`，再切回本机用户直接跑时，可能会遇到权限问题。最直接的处理方式是二选一：

```bash
sudo chown -R "$USER":"$USER" /path/to/linkualog/master-server/local_data
```

或：

```bash
rm -rf /path/to/linkualog/master-server/local_data
mkdir -p /path/to/linkualog/master-server/local_data
```

默认行为：

- 非 Docker 环境下，主前端默认地址是 `http://localhost:8000`
- 后端 API 默认地址是 `http://localhost:8080`
- `uv run main.py` 会启动 FastAPI，并在需要时拉起前端开发服务

如果你只想跑后端：

```bash
cd /path/to/linkualog/master-server
MASTER_SERVER_DISABLE_FRONTEND=1 uv run main.py
```

如果你要跑当前这次补上的 QQ connector 回归测试：

```bash
cd /path/to/linkualog/master-server
uv run --no-sync python -m unittest discover -s tests -v
```

## 服务器 Docker 部署

在仓库根目录执行：

```bash
cd /path/to/linkualog
cp .env.example .env
# 编辑 .env，至少填入 MASTER_SERVER_LLM_API_KEY
# 如果需要，可顺手调整三个镜像源变量

docker compose up -d --build master-server
```

当前 Docker 路径以 `master-server/pyproject.toml + master-server/uv.lock` 为唯一 Python 依赖来源。构建阶段会执行 `uv sync --frozen`，避免再维护一套独立的 Docker Python 依赖清单。

默认对外端口：

- `http://服务器IP/`：前端
- `http://服务器IP:8080/`：同一套后端 / API

常用运维命令：

```bash
docker compose logs -f master-server
docker compose up -d --build master-server
docker compose restart master-server
```

数据与配置会保存在宿主机：

- `./data`
- `./master-server/local_data`

## 说明

- OCR 下划线词坐标现在默认开启，不再需要实验开关
- Docker 镜像里已经安装 `poppler-utils`，PDF 分页可直接使用
- 本机或容器处理 PDF 时，当前支持三层路径：`pdf2image`、`pdftoppm`、`pymupdf`
- 如果你想让 FastAPI 直接托管构建产物，Compose 默认已经启用 `MASTER_SERVER_SERVE_BUILT_FRONTEND=1`
