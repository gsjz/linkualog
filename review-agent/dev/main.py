import logging
import os
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


def _configure_logging() -> None:
    level_name = _first_non_empty("REVIEW_SERVER_LOG_LEVEL", "LOG_LEVEL", fallback="INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        )
    else:
        root.setLevel(level)

    logging.getLogger("review_agent").setLevel(level)
    logging.getLogger("review_agent.api").setLevel(level)
    logging.getLogger("review_agent.llm").setLevel(level)


REPO_ROOT = Path(__file__).resolve().parents[2]
_load_dotenv(REPO_ROOT / ".env")
_configure_logging()

os.environ.setdefault("AGENT_CONFIG", "local_data/agent_config.json")
os.environ.setdefault(
    "DEFAULT_PROVIDER",
    _first_non_empty(
        "REVIEW_SERVER_LLM_PROVIDER",
        "REVIEW_AGENT_LLM_PROVIDER",
        "MASTER_SERVER_LLM_PROVIDER",
        "LLM_PROVIDER",
        fallback="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ),
)
os.environ.setdefault(
    "DEFAULT_MODEL",
    _first_non_empty(
        "REVIEW_SERVER_LLM_MODEL",
        "REVIEW_AGENT_LLM_MODEL",
        "MASTER_SERVER_LLM_MODEL",
        "LLM_MODEL",
        fallback="qwen3.5-flash",
    ),
)
os.environ.setdefault(
    "DEFAULT_API_KEY",
    _first_non_empty(
        "REVIEW_SERVER_LLM_API_KEY",
        "REVIEW_AGENT_LLM_API_KEY",
        "MASTER_SERVER_LLM_API_KEY",
        "LLM_API_KEY",
        fallback="",
    ),
)
os.environ.setdefault("VOCAB_DIR", "../../data/")
os.environ.setdefault("MAX_SCAN_FILES", "2000")

from api.routes import router
from utils.runner import start_frontend_dev

app = FastAPI(title="review-agent", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

if __name__ == "__main__":
    FRONTEND_PORT = _read_port(
        8091,
        "REVIEW_SERVER_FRONTEND_PORT",
        "REVIEW_AGENT_FRONTEND_PORT",
        "FRONTEND_PORT",
    )
    BACKEND_PORT = _read_port(
        8090,
        "REVIEW_SERVER_BACKEND_PORT",
        "REVIEW_AGENT_BACKEND_PORT",
        "BACKEND_PORT",
    )
    START_FRONTEND = os.environ.get("REVIEW_SERVER_DISABLE_FRONTEND", "0").strip() not in {"1", "true", "TRUE"}

    if START_FRONTEND:
        frontend_thread = threading.Thread(target=start_frontend_dev, args=(FRONTEND_PORT, BACKEND_PORT))
        frontend_thread.daemon = True
        frontend_thread.start()

    uvicorn.run(app, host="0.0.0.0", port=BACKEND_PORT)
