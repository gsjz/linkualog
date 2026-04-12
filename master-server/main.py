import os
import logging
import threading
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


def _configure_logging(config: dict | None = None) -> None:
    config = config if isinstance(config, dict) else {}
    level_name = str(
        config.get("log_level")
        or _first_non_empty("MASTER_SERVER_LOG_LEVEL", "LOG_LEVEL", fallback="INFO")
    ).upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        )
    else:
        root.setLevel(level)

    logging.getLogger("master_server.review").setLevel(level)
    logging.getLogger("master_server.review.api").setLevel(level)
    logging.getLogger("master_server.review.llm").setLevel(level)


APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parent
_load_dotenv(REPO_ROOT / ".env")
from core.config import get_config_data
from api.routes import router as master_router
from api.review_routes import router as review_router
from utils.runner import start_frontend_dev

_configure_logging(get_config_data())

os.environ.setdefault("STORAGE_DIR", str(APP_DIR / "local_data/temp_storage"))
os.environ.setdefault("MAX_SIZE_BYTES", str(1 * 1024 * 1024 * 1024))

os.environ.setdefault("TASKS_FILE", str(APP_DIR / "local_data/tasks_db.json"))
os.environ.setdefault("LOCK_FILE", str(APP_DIR / "local_data/tasks_db.json.lock"))

os.environ.setdefault("VOCAB_DIR", str(REPO_ROOT / "data"))
os.environ.setdefault("MAX_SCAN_FILES", "2000")

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

app.include_router(master_router)
app.include_router(review_router)

if __name__ == "__main__":
    runtime_config = get_config_data()
    backend_port = _read_port(int(runtime_config.get("backend_port", 8080)), "MASTER_SERVER_BACKEND_PORT", "BACKEND_PORT")
    frontend_port = _read_port(int(runtime_config.get("frontend_port", 8000)), "MASTER_SERVER_FRONTEND_PORT", "FRONTEND_PORT")
    start_master_frontend = os.environ.get("MASTER_SERVER_DISABLE_FRONTEND", "0").strip().lower() not in {"1", "true"}

    if start_master_frontend:
        frontend_thread = threading.Thread(target=start_frontend_dev, args=(frontend_port, backend_port))
        frontend_thread.daemon = True
        frontend_thread.start()

    print(f"🚀 正在启动 FastAPI 后端服务 (端口: {backend_port})...")
    uvicorn.run(app, host="0.0.0.0", port=backend_port)
