from __future__ import annotations

import json
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
CONFIG_FILE = Path(os.environ.get("CONFIG_FILE", APP_DIR / "local_data/llm_config.json"))


def is_running_in_docker() -> bool:
    return Path("/.dockerenv").exists() or str(os.environ.get("DOCKER_CONTAINER", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _first_non_empty(*keys: str, fallback: str = "") -> str:
    for key in keys:
        value = str(os.environ.get(key, "")).strip()
        if value:
            return value
    return fallback


def _read_bool(value, default: bool) -> bool:
    raw = str(value or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _read_int(value, default: int) -> int:
    try:
        parsed = int(value)
        if 1 <= parsed <= 65535:
            return parsed
    except (TypeError, ValueError):
        pass
    return default


def _read_positive_int(value, default: int) -> int:
    try:
        parsed = int(value)
        if parsed > 0:
            return parsed
    except (TypeError, ValueError):
        pass
    return default


def _read_non_negative_float(value, default: float) -> float:
    try:
        parsed = float(value)
        if parsed >= 0:
            return parsed
    except (TypeError, ValueError):
        pass
    return default


def _default_frontend_port() -> int:
    return 80 if is_running_in_docker() else 8000


def _specs() -> dict[str, dict]:
    return {
        "provider": {
            "kind": "str",
            "env": ["MASTER_SERVER_LLM_PROVIDER", "MASTER_LLM_PROVIDER", "LLM_PROVIDER"],
            "default": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        },
        "model": {
            "kind": "str",
            "env": ["MASTER_SERVER_LLM_MODEL", "MASTER_LLM_MODEL", "LLM_MODEL"],
            "default": "qwen3.5-flash",
        },
        "api_key": {
            "kind": "str",
            "env": ["MASTER_SERVER_LLM_API_KEY", "MASTER_LLM_API_KEY", "LLM_API_KEY"],
            "default": "",
        },
        "experimental_coordinates_enabled": {
            "kind": "bool",
            "env": ["MASTER_SERVER_EXPERIMENTAL_COORDINATES_ENABLED"],
            "default": False,
        },
        "frontend_port": {
            "kind": "port",
            "env": ["MASTER_SERVER_FRONTEND_PORT", "FRONTEND_PORT"],
            "default": _default_frontend_port(),
        },
        "backend_port": {
            "kind": "port",
            "env": ["MASTER_SERVER_BACKEND_PORT", "BACKEND_PORT"],
            "default": 8080,
        },
        "log_level": {
            "kind": "str",
            "env": ["MASTER_SERVER_LOG_LEVEL", "LOG_LEVEL"],
            "default": "INFO",
        },
        "review_llm_timeout_seconds": {
            "kind": "float",
            "env": ["MASTER_SERVER_REVIEW_LLM_TIMEOUT_SECONDS", "MASTER_SERVER_LLM_TIMEOUT_SECONDS"],
            "default": 75.0,
        },
        "review_folder_merge_llm_timeout_seconds": {
            "kind": "float",
            "env": ["MASTER_SERVER_REVIEW_FOLDER_MERGE_LLM_TIMEOUT_SECONDS"],
            "default": 90.0,
        },
        "review_folder_merge_llm_max_tokens": {
            "kind": "positive_int",
            "env": ["MASTER_SERVER_REVIEW_FOLDER_MERGE_LLM_MAX_TOKENS"],
            "default": 900,
        },
        "review_folder_merge_llm_max_tokens_cap": {
            "kind": "positive_int",
            "env": ["MASTER_SERVER_REVIEW_FOLDER_MERGE_LLM_MAX_TOKENS_CAP"],
            "default": 3200,
        },
        "review_folder_merge_max_suggestions": {
            "kind": "positive_int",
            "env": ["MASTER_SERVER_REVIEW_FOLDER_MERGE_MAX_SUGGESTIONS"],
            "default": 40,
        },
        "review_folder_merge_temperature": {
            "kind": "float",
            "env": ["MASTER_SERVER_REVIEW_FOLDER_MERGE_TEMPERATURE"],
            "default": 0.0,
        },
        "review_folder_merge_word_limit": {
            "kind": "positive_int",
            "env": ["MASTER_SERVER_REVIEW_FOLDER_MERGE_WORD_LIMIT"],
            "default": 200,
        },
        "review_llm_connectivity_check": {
            "kind": "bool",
            "env": ["MASTER_SERVER_REVIEW_LLM_CONNECTIVITY_CHECK"],
            "default": True,
        },
        "review_llm_connectivity_timeout_seconds": {
            "kind": "float",
            "env": ["MASTER_SERVER_REVIEW_LLM_CONNECTIVITY_TIMEOUT_SECONDS"],
            "default": 3.0,
        },
        "review_llm_connectivity_strict": {
            "kind": "bool",
            "env": ["MASTER_SERVER_REVIEW_LLM_CONNECTIVITY_STRICT"],
            "default": False,
        },
        "review_llm_connectivity_probe_ttl_seconds": {
            "kind": "float",
            "env": ["MASTER_SERVER_REVIEW_LLM_CONNECTIVITY_PROBE_TTL_SECONDS"],
            "default": 180.0,
        },
        "review_llm_request_max_retries": {
            "kind": "positive_int",
            "env": ["MASTER_SERVER_REVIEW_LLM_REQUEST_MAX_RETRIES"],
            "default": 2,
        },
        "review_llm_request_retry_backoff_seconds": {
            "kind": "float",
            "env": ["MASTER_SERVER_REVIEW_LLM_REQUEST_RETRY_BACKOFF_SECONDS"],
            "default": 1.0,
        },
    }


CONFIG_SPECS = _specs()


def _normalize_value(key: str, value):
    spec = CONFIG_SPECS[key]
    default = spec["default"]
    kind = spec["kind"]

    if kind == "str":
        return str(value or "").strip() or str(default)
    if kind == "bool":
        return _read_bool(value, bool(default))
    if kind == "port":
        return _read_int(value, int(default))
    if kind == "positive_int":
        return _read_positive_int(value, int(default))
    if kind == "float":
        return _read_non_negative_float(value, float(default))
    return value


def _load_saved_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}

    return data if isinstance(data, dict) else {}


def get_env_defaults() -> dict:
    defaults = {}
    for key, spec in CONFIG_SPECS.items():
        raw_value = _first_non_empty(*spec["env"], fallback="")
        defaults[key] = _normalize_value(key, raw_value if raw_value else spec["default"])
    return defaults


def get_config_data() -> dict:
    config = get_env_defaults()
    saved = _load_saved_config()

    for key in CONFIG_SPECS:
        if key not in saved:
            continue
        if key == "api_key" and not str(saved.get(key, "")).strip():
            continue
        config[key] = _normalize_value(key, saved.get(key))

    config["hasKey"] = bool(str(config.get("api_key", "")).strip())
    config["running_in_docker"] = is_running_in_docker()
    config["config_file"] = str(CONFIG_FILE)
    return config


def get_public_config_data() -> dict:
    data = get_config_data()
    return {
        key: value
        for key, value in data.items()
        if key not in {"api_key", "config_file"}
    }


def save_config_data(payload: dict | None = None) -> dict:
    payload = payload if isinstance(payload, dict) else {}
    saved = _load_saved_config()

    for key in CONFIG_SPECS:
        if key not in payload:
            continue

        if key == "api_key":
            api_key = str(payload.get("api_key", "") or "").strip()
            if api_key:
                saved[key] = api_key
            continue

        saved[key] = _normalize_value(key, payload.get(key))

    config_dir = CONFIG_FILE.parent
    if config_dir:
        os.makedirs(config_dir, exist_ok=True)

    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(saved, f, ensure_ascii=False, indent=2)

    return get_config_data()
