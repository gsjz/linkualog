# review-agent/dev

一个用于 `data/` 词库精加工的前后端服务，架构风格与 `master-server/dev` 一致：
- 后端：FastAPI（`api/core/services` 分层 + JSON 文件持久化）
- 前端：Vite + React 控制台（目录合并、文件清洗、复习打分）
  - 支持“应用建议到草稿”与“保存回 data”

## 运行

```bash
uv sync
uv run main.py
```

默认端口：
- 前端 `8091`
- 后端 `8090`
默认访问地址：`http://localhost:8091`

如只想运行后端，可设置 `REVIEW_SERVER_DISABLE_FRONTEND=1`。

## 统一 .env 配置

项目根目录 `.env` 支持以下键：

- `MASTER_SERVER_LLM_PROVIDER`
- `MASTER_SERVER_LLM_MODEL`
- `MASTER_SERVER_LLM_API_KEY`
- `REVIEW_SERVER_LLM_PROVIDER`
- `REVIEW_SERVER_LLM_MODEL`
- `REVIEW_SERVER_LLM_API_KEY`
- `REVIEW_SERVER_FRONTEND_PORT`
- `REVIEW_SERVER_BACKEND_PORT`

`review-agent` 会优先读取 `REVIEW_SERVER_*`；未提供时会回退到 `MASTER_SERVER_*`。

## API

- `POST /api/vocabulary/save`
  - 入参：`{ "category": "...", "filename": "...", "data": { ...完整词条... } }`
  - 输出：保存后的词条内容。
- `POST /api/refine/merge/apply`
  - 入参：`{ "category": "...", "source_filename": "...", "target_filename": "...", "delete_source": false }`
  - 输出：合并后的目标词条内容。
- `POST /api/refine/folder`
  - 入参：`{ "category": "cet", "include_low_confidence": false }`
  - 输出：同目录词形变体的合并建议。
- `POST /api/refine/file`
  - 入参：`{ "category": "cet", "filename": "abandon", "include_llm": true }`
  - 输出：单文件清洗建议（重复释义、冗余上下文、空翻译等），可选追加 LLM 建议。
- `POST /api/review/suggest`
  - 入参：`{ "category": "cet", "filename": "abandon", "score": 4 }`
  - 输出：复习建议（SM2 风格）并自动回写本次 `reviews`。
