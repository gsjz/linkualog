import os
import logging
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


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


def _read_bool_env(key: str, default: bool) -> bool:
    raw_value = os.environ.get(key)
    if raw_value is None:
        return default

    normalized = str(raw_value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parent
_load_dotenv(REPO_ROOT / ".env")
from core.config import get_config_data, is_running_in_docker
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


def _should_serve_built_frontend() -> bool:
    return _read_bool_env("MASTER_SERVER_SERVE_BUILT_FRONTEND", is_running_in_docker())


HTML_NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        normalized_path = str(path or "").strip().lower()
        if response.status_code == 200 and normalized_path.endswith(".html"):
            response.headers.update(HTML_NO_CACHE_HEADERS)
        return response


def _html_file_response(path: Path) -> FileResponse:
    return FileResponse(path, headers=HTML_NO_CACHE_HEADERS)


def _mount_frontend_static(target_app: FastAPI) -> bool:
    dist_dir = APP_DIR / "frontend" / "dist"
    index_file = dist_dir / "index.html"
    review_file = dist_dir / "review.html"

    if not _should_serve_built_frontend() or not index_file.exists():
        return False

    @target_app.get("/", include_in_schema=False)
    def serve_frontend_index():
        return _html_file_response(index_file)

    @target_app.get("/review", include_in_schema=False)
    @target_app.get("/review/", include_in_schema=False)
    @target_app.get("/review.html", include_in_schema=False)
    def serve_review_index():
        return _html_file_response(review_file if review_file.exists() else index_file)

    target_app.mount("/", FrontendStaticFiles(directory=dist_dir, html=True), name="frontend")
    return True

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
SERVING_BUILT_FRONTEND = _mount_frontend_static(app)

if __name__ == "__main__":
    runtime_config = get_config_data()
    backend_port = _read_port(int(runtime_config.get("backend_port", 8080)), "MASTER_SERVER_BACKEND_PORT", "BACKEND_PORT")
    frontend_port = _read_port(int(runtime_config.get("frontend_port", 8000)), "MASTER_SERVER_FRONTEND_PORT", "FRONTEND_PORT")
    start_master_frontend = os.environ.get("MASTER_SERVER_DISABLE_FRONTEND", "0").strip().lower() not in {"1", "true"}
    start_master_frontend = start_master_frontend and not SERVING_BUILT_FRONTEND

    if start_master_frontend:
        frontend_thread = threading.Thread(target=start_frontend_dev, args=(frontend_port, backend_port))
        frontend_thread.daemon = True
        frontend_thread.start()
    elif SERVING_BUILT_FRONTEND:
        print("🧩 已启用内置前端静态资源，由 FastAPI 同端口对外提供服务。")

    print(f"🚀 正在启动 FastAPI 后端服务 (端口: {backend_port})...")
    uvicorn.run(app, host="0.0.0.0", port=backend_port)
