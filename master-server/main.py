import os
import logging
import asyncio
import threading
from pathlib import Path

import requests
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException


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

os.environ.setdefault("DATA_DIR", str(REPO_ROOT / "data"))
os.environ.setdefault("VOCAB_DIR", str(REPO_ROOT / "data" / "vocabulary"))
os.environ.setdefault("STORAGE_DIR", str(APP_DIR / "local_data/temp_storage"))
os.environ.setdefault("TASKS_FILE", str(APP_DIR / "local_data/tasks_db.json"))
os.environ.setdefault("LOCK_FILE", str(APP_DIR / "local_data/tasks_db.json.lock"))
os.environ.setdefault("MAX_SIZE_BYTES", str(1 * 1024 * 1024 * 1024))
os.environ.setdefault("MAX_SCAN_FILES", "2000")

from core.config import get_config_data, is_running_in_docker
from api.routes import router as master_router
from api.review_routes import router as review_router
from utils.runner import start_frontend_dev

_configure_logging(get_config_data())


def _should_serve_built_frontend() -> bool:
    return _read_bool_env("MASTER_SERVER_SERVE_BUILT_FRONTEND", is_running_in_docker())


HTML_NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


class FrontendStaticFiles(StaticFiles):
    def __init__(self, *args, spa_fallback_file: Path | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.spa_fallback_file = spa_fallback_file

    def _should_spa_fallback(self, path: str) -> bool:
        normalized_path = str(path or "").strip().lstrip("/")
        if not normalized_path:
            return False
        if normalized_path.startswith(("api/", "assets/")):
            return False
        return not Path(normalized_path).suffix

    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404 and self.spa_fallback_file and self._should_spa_fallback(path):
                return _html_file_response(self.spa_fallback_file)
            raise

        normalized_path = str(path or "").strip().lower()
        if response.status_code == 404 and self.spa_fallback_file and self._should_spa_fallback(path):
            return _html_file_response(self.spa_fallback_file)
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

    target_app.mount("/", FrontendStaticFiles(directory=dist_dir, html=True, spa_fallback_file=index_file), name="frontend")
    return True


def _get_knotodo_proxy_base_url() -> str:
    default_base_url = "http://knotodo:18083/todo" if is_running_in_docker() else "http://127.0.0.1:18082/todo"
    return _first_non_empty(
        "MASTER_SERVER_KNOTODO_BASE_URL",
        "KNOTODO_INTERNAL_BASE_URL",
        fallback=default_base_url,
    ).rstrip("/")


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def _proxy_request_headers(request: Request) -> dict[str, str]:
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }
    headers["accept-encoding"] = "identity"
    return headers


def _proxy_response_headers(response: requests.Response) -> dict[str, str]:
    excluded = HOP_BY_HOP_HEADERS | {"content-encoding"}
    return {
        key: value
        for key, value in response.headers.items()
        if key.lower() not in excluded
    }


async def _proxy_knotodo_request(request: Request, path: str = "") -> Response:
    base_url = _get_knotodo_proxy_base_url()
    normalized_path = str(path or "").lstrip("/")
    target_url = f"{base_url}/{normalized_path}" if normalized_path else base_url
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    try:
        upstream = await asyncio.to_thread(
            requests.request,
            method=request.method,
            url=target_url,
            headers=_proxy_request_headers(request),
            data=await request.body(),
            timeout=30,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        return Response(
            content=f"KnoTodo service is not available: {exc}",
            status_code=502,
            media_type="text/plain; charset=utf-8",
        )

    content = b"" if request.method.upper() == "HEAD" else upstream.content
    return Response(
        content=content,
        status_code=upstream.status_code,
        headers=_proxy_response_headers(upstream),
        media_type=upstream.headers.get("content-type"),
    )

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


@app.api_route("/todo", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
async def proxy_knotodo_root(request: Request):
    return await _proxy_knotodo_request(request)


@app.api_route("/todo/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
async def proxy_knotodo_path(request: Request, path: str):
    return await _proxy_knotodo_request(request, path)


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
