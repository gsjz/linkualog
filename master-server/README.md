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

`MASTER_SERVER_LLM_PROVIDER` 现在支持直接填写 Base URL，例如：

- `https://api.openai.com/v1`
- `https://dashscope.aliyuncs.com/compatible-mode/v1`

服务端请求时会自动补全 `/chat/completions`。

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
./deploy.sh master-server
```

默认地址：

- 前端和 API：`http://127.0.0.1:18080/`
- FastAPI 直连端口：`http://127.0.0.1:18081/`

常用命令：

```bash
make logs-master
make rebuild-master
make ps
```

持久化目录：

- `./data/vocabulary`
- `./master-server/local_data`

## 测试

```bash
cd /path/to/linkualog/master-server
uv run --no-sync python -m unittest discover -s tests -v
```

前端异步交互回归测试位于 `frontend/tests/`，覆盖任务切换、上传失败恢复、
词条切换与设置读取失败。先用 `make rebuild-master` 更新 Docker 页面，再运行：

```bash
# 在仓库根目录执行；Playwright 依赖和浏览器都留在一次性容器中。
docker run --rm --network host \
  -v "$PWD:/work" -w /tmp \
  -e NODE_PATH=/tmp/node_modules \
  -e BASE_URL=http://127.0.0.1:18080 \
  -e OUT_DIR=/work/.tmp-layout-check/bug-audit \
  mcr.microsoft.com/playwright:v1.60.0-noble \
  bash -lc 'npm install --no-save playwright@1.60.0 &&
    node /work/master-server/frontend/tests/task-races.cjs &&
    FULL_MATRIX=1 node /work/master-server/frontend/tests/vocabulary-races.cjs &&
    FULL_MATRIX=1 node /work/master-server/frontend/tests/editor-launch.cjs &&
    node /work/master-server/frontend/tests/config-recovery.cjs &&
    node /work/master-server/frontend/tests/task-popovers.cjs'
```

这些回归通过浏览器拦截模拟延迟和失败，不调用真实 LLM，也不修改运行数据。
截图和结果写入 `.tmp-layout-check/bug-audit/`。

## 说明

- Docker 镜像已安装 `poppler-utils`，PDF 分页可直接使用。
- 本机或容器处理 PDF 时支持 `pdf2image`、`pdftoppm`、`pymupdf` 三层路径。
- Docker 部署时 FastAPI 会同端口托管构建后的前端。
