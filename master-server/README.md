# master-server

`master-server` 是 Linkualog 的主应用：FastAPI 后端 + React 前端。它负责上传图片/PDF、OCR/LLM 解析、生词本读写、精修合并和复习。

## 配置

默认读取仓库根目录的 `.env`：

```bash
cd /path/to/linkualog
cp .env.example .env
# 至少填写 MASTER_SERVER_LLM_API_KEY
```

常用配置：

- `MASTER_SERVER_LLM_PROVIDER`
- `MASTER_SERVER_LLM_MODEL`
- `MASTER_SERVER_LLM_API_KEY`

前端“全局配置”会写入 `master-server/local_data/llm_config.json`，用于覆盖 `.env` 中的部分设置。

## 本地运行

建议环境：Python `3.13`、`uv`、Node.js `20`、`npm`。本地处理 PDF 时还需要 `poppler-utils`。

```bash
cd /path/to/linkualog/master-server
uv sync
uv run main.py
```

默认地址：

- 主前端：`http://localhost:8000`
- 后端 API：`http://localhost:8080`

只启动后端：

```bash
MASTER_SERVER_DISABLE_FRONTEND=1 uv run main.py
```

如果本地运行时遇到 `local_data` 权限问题，通常是之前用 Docker 或 root 写过文件：

```bash
sudo chown -R "$USER":"$USER" /path/to/linkualog/master-server/local_data
```

## Docker 运行

在仓库根目录执行：

```bash
cd /path/to/linkualog
docker compose up -d --build master-server
```

默认地址：

- 前端：`http://服务器IP/`
- 后端 API：`http://服务器IP:8080/`

常用命令：

```bash
docker compose logs -f master-server
docker compose restart master-server
docker compose up -d --build master-server
```

持久化目录：

- `./data`
- `./master-server/local_data`

## 测试

```bash
cd /path/to/linkualog/master-server
uv run --no-sync python -m unittest discover -s tests -v
```

## 说明

- Docker 镜像已安装 `poppler-utils`，PDF 分页可直接使用。
- 本机或容器处理 PDF 时支持 `pdf2image`、`pdftoppm`、`pymupdf` 三层路径。
- Docker 部署时 FastAPI 会同端口托管构建后的前端。
