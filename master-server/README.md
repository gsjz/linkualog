# master-server

统一后的 `master-server` 只保留一套后端和一个前端工程：

- `frontend/`：唯一前端工程，`src/` 下包含主界面与 `src/review/` 精修模块，并提供 `index.html` 与 `review.html` 两个入口
- FastAPI 后端：统一 API，默认端口 `8080`

## 运行

```bash
uv sync
uv run main.py
```

可选环境变量：

- `MASTER_SERVER_DISABLE_FRONTEND=1`：禁用主前端，仅启动后端
- `MASTER_SERVER_BACKEND_PORT`：统一后端端口
- `MASTER_SERVER_FRONTEND_PORT`：统一前端端口
- `MASTER_SERVER_LOG_LEVEL`：日志级别

端口默认值：

- 本地直接运行 `uv run main.py` 时，前端默认端口是 `8000`
- Docker / Compose 运行时，前端默认端口是 `80`
- 后端默认端口始终是 `8080`

配置来源优先级：

- `.env` 提供默认值
- `local_data/llm_config.json` 保存前端设置页里修改后的值
- 没有 `.env` 时也会使用内置默认值继续启动
