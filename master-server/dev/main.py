import os
import time
import threading
import logging
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("export "):
            line = line[len("export ") :].strip()

        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"}:
            value = value[1:-1]

        os.environ.setdefault(key, value)


def _first_non_empty(*keys: str, fallback: str) -> str:
    for key in keys:
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return fallback


def _read_port(default: int, *keys: str) -> int:
    raw = _first_non_empty(*keys, fallback=str(default))
    try:
        port = int(raw)
        if 1 <= port <= 65535:
            return port
    except (TypeError, ValueError):
        pass

    print(f"⚠️ 端口配置非法({raw})，回退默认端口 {default}")
    return default


REPO_ROOT = Path(__file__).resolve().parents[2]
_load_dotenv(REPO_ROOT / ".env")

os.environ.setdefault("CONFIG_FILE", "local_data/llm_config.json")
os.environ.setdefault(
    "DEFAULT_PROVIDER",
    _first_non_empty(
        "MASTER_SERVER_LLM_PROVIDER",
        "MASTER_LLM_PROVIDER",
        "LLM_PROVIDER",
        fallback="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ),
)
os.environ.setdefault(
    "DEFAULT_MODEL",
    _first_non_empty(
        "MASTER_SERVER_LLM_MODEL",
        "MASTER_LLM_MODEL",
        "LLM_MODEL",
        fallback="qwen3.5-flash",
    ),
)
os.environ.setdefault(
    "DEFAULT_API_KEY",
    _first_non_empty(
        "MASTER_SERVER_LLM_API_KEY",
        "MASTER_LLM_API_KEY",
        "LLM_API_KEY",
        fallback="",
    ),
)

os.environ.setdefault("STORAGE_DIR", "local_data/temp_storage")
os.environ.setdefault("MAX_SIZE_BYTES", str(1 * 1024 * 1024 * 1024)) # 1GB 限制

os.environ.setdefault("TASKS_FILE", "local_data/tasks_db.json")
os.environ.setdefault("LOCK_FILE", "local_data/tasks_db.json.lock")

os.environ.setdefault("VOCAB_DIR", "../../data/")

from api.routes import router
from utils.runner import start_frontend_dev

class EndpointFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "GET /api/task" in msg:
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(EndpointFilter())

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

if __name__ == "__main__":
    FRONTEND_PORT = _read_port(8000, "MASTER_SERVER_FRONTEND_PORT", "FRONTEND_PORT")
    BACKEND_PORT = _read_port(8080, "MASTER_SERVER_BACKEND_PORT", "BACKEND_PORT")
    
    frontend_thread = threading.Thread(target=start_frontend_dev, args=(FRONTEND_PORT, BACKEND_PORT))
    frontend_thread.daemon = True
    frontend_thread.start()
    
    print(f"🚀 正在启动 FastAPI 后端服务 (端口: {BACKEND_PORT})...")
    uvicorn.run(app, host="0.0.0.0", port=BACKEND_PORT)
