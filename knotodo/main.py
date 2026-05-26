import logging
import os
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI
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
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
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

    print(f"端口配置非法({raw})，回退默认端口 {default}")
    return default


def _read_bool_env(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default

    normalized = str(raw).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _normalize_base_path(value: str | None) -> str:
    path = str(value or "").strip()
    if not path or path == "/":
        return ""
    return "/" + path.strip("/")


def _configure_logging() -> None:
    level_name = _first_non_empty("KNOTODO_LOG_LEVEL", "LOG_LEVEL", fallback="INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s")


APP_DIR = Path(__file__).resolve().parent
_load_dotenv(APP_DIR / ".env")

from api.routes import router
from utils.runner import start_frontend_dev

_configure_logging()

app = FastAPI(title="KnoTodo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
BASE_PATH = _normalize_base_path(os.environ.get("KNOTODO_BASE_PATH", ""))
if BASE_PATH:
    app.include_router(router, prefix=BASE_PATH, include_in_schema=False)

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


def _should_serve_built_frontend() -> bool:
    return _read_bool_env("KNOTODO_SERVE_BUILT_FRONTEND", False)


def _mount_frontend_static(target_app: FastAPI) -> bool:
    dist_dir = APP_DIR / "frontend" / "dist"
    index_file = dist_dir / "index.html"
    if not _should_serve_built_frontend() or not index_file.exists():
        return False

    if BASE_PATH:
        @target_app.get(BASE_PATH, include_in_schema=False)
        @target_app.get(f"{BASE_PATH}/", include_in_schema=False)
        def serve_prefixed_frontend_index():
            return _html_file_response(index_file)

        target_app.mount(
            BASE_PATH,
            FrontendStaticFiles(directory=dist_dir, html=True, spa_fallback_file=index_file),
            name="frontend_prefixed",
        )

    @target_app.get("/", include_in_schema=False)
    def serve_frontend_index():
        return _html_file_response(index_file)

    target_app.mount("/", FrontendStaticFiles(directory=dist_dir, html=True, spa_fallback_file=index_file), name="frontend")
    return True


SERVING_BUILT_FRONTEND = _mount_frontend_static(app)


if __name__ == "__main__":
    backend_port = _read_port(8081, "KNOTODO_BACKEND_PORT", "BACKEND_PORT")
    frontend_port = _read_port(4173, "KNOTODO_FRONTEND_PORT", "FRONTEND_PORT")
    start_frontend = not _read_bool_env("KNOTODO_DISABLE_FRONTEND", False) and not SERVING_BUILT_FRONTEND

    if start_frontend:
        frontend_thread = threading.Thread(target=start_frontend_dev, args=(frontend_port, backend_port))
        frontend_thread.daemon = True
        frontend_thread.start()
    elif SERVING_BUILT_FRONTEND:
        print("已启用内置前端静态资源，由 FastAPI 同端口对外提供服务。")

    print(f"正在启动 KnoTodo 后端服务 (端口: {backend_port})")
    uvicorn.run(app, host="0.0.0.0", port=backend_port)
