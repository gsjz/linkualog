from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
import hashlib
import json
import mimetypes
import os
import platform
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import review_teaching as review_teaching_mod
import websockets


TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
GATEWAY_URL = "https://api.sgroup.qq.com/gateway/bot"
OPENAPI_BASE_URL = "https://api.sgroup.qq.com"
C2C_AND_GROUP_INTENTS = 1 << 25
REPO_ROOT = APP_DIR.parent
APP_SLUG = "linkualog-qq-bot"
COMMAND_PREFIX = "\\"
PING_COMMAND = f"{COMMAND_PREFIX}ping"
HELP_COMMAND = f"{COMMAND_PREFIX}help"
STATUS_COMMAND = f"{COMMAND_PREFIX}status"
CATEGORIES_COMMAND = f"{COMMAND_PREFIX}categories"
CD_COMMAND = f"{COMMAND_PREFIX}cd"
SEARCH_COMMAND = f"{COMMAND_PREFIX}search"
ADD_COMMAND = f"{COMMAND_PREFIX}add"
UPLOAD_COMMAND = f"{COMMAND_PREFIX}upload"
NAME_COMMAND = f"{COMMAND_PREFIX}name"
AUTO_COMMAND = f"{COMMAND_PREFIX}auto"
REVIEW_COMMAND = f"{COMMAND_PREFIX}review"
MODE_COMMAND = f"{COMMAND_PREFIX}mode"
SKIP_COMMAND = f"{COMMAND_PREFIX}skip"
TASK_COMMAND = f"{COMMAND_PREFIX}task"
PROCESS_COMMAND = f"{COMMAND_PREFIX}process"
END_COMMAND = f"{COMMAND_PREFIX}end"
WS_EVENT_TYPES_REQUIRING_REPLY = {
    "C2C_MESSAGE_CREATE",
    "GROUP_AT_MESSAGE_CREATE",
}

DEFAULT_LINKUALOG_ENV_FILE = str(REPO_ROOT / ".env")
DEFAULT_LINKUALOG_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_LINKUALOG_DATA_DIR = str(REPO_ROOT / "data")

WS_PATTERN = re.compile(r"\s+")
MENTION_PATTERN = re.compile(r"<@[^>]+>")
SAFE_WORD_CHARS_PATTERN = re.compile(r"[^a-z0-9-]+")
DIRECT_WORD_PATTERN = re.compile(r"[a-z][a-z0-9-]{1,63}")
CATEGORY_PATTERN = re.compile(r"[^a-z0-9._-]+")
REVIEW_KEY_PATTERN = re.compile(r"^[^/]+/[^/]+\.json$")
REVIEW_NOISE_MARKER_PATTERN = re.compile(r"(?:\[[0-9]{1,3}\]|https?://\S+|www\.\S+|example\.com)", re.IGNORECASE)
REVIEW_TRANSCRIPT_PATTERN = re.compile(r"(?i)(?:^|[\s(（\"'])(?:m|w|q|a|man|woman)\s*[:：]")
REVIEW_SPEAKER_PREFIX_PATTERN = re.compile(r"^(?:(?:m|w|q|a|man|woman|男|女|主持人|记者|旁白)\s*[:：]\s*)+", re.IGNORECASE)
ATTACHMENT_URL_KEYS = (
    "url",
    "download_url",
    "downloadUrl",
    "file_url",
    "fileUrl",
    "src",
    "proxy_url",
    "proxyUrl",
)
ATTACHMENT_NAME_KEYS = (
    "filename",
    "file_name",
    "fileName",
    "name",
    "title",
)
ATTACHMENT_MIME_KEYS = (
    "content_type",
    "contentType",
    "mime_type",
    "mimeType",
    "type",
)
YES_WORDS = {"y", "yes", "1", "ok", "okay", "确认", "同意", "继续"}
NO_WORDS = {"n", "no", "0", "cancel", "取消", "算了", "不要"}
CLEANUP_APPROVE_WORDS = {"y", "yes", "1", "ok", "okay", "确认", "同意"}
ON_WORDS = {"1", "on", "true", "yes", "y", "enable", "enabled", "open", "开启", "打开", "开", "自动", "是"}
OFF_WORDS = {"0", "off", "false", "no", "n", "disable", "disabled", "close", "关闭", "关", "手动", "否"}
GREETING_WORDS = {"你好", "您好", "hi", "hello", "hey", "嗨", "哈喽", "在吗", "在么"}
REVIEW_MODE_ALIASES = review_teaching_mod.REVIEW_MODE_ALIASES
REVIEW_MODE_LABELS = review_teaching_mod.REVIEW_MODE_LABELS
REVIEW_MODE_DESCRIPTIONS = review_teaching_mod.REVIEW_MODE_DESCRIPTIONS
CREATIVE_REVIEW_TEMPLATES = review_teaching_mod.CREATIVE_REVIEW_TEMPLATES
HELP_TEXT = (
    "### Linkualog QQ Bot\n\n"
    "**常用命令**\n\n"
    f"- `{PING_COMMAND}` 检查在线状态\n"
    f"- `{STATUS_COMMAND}` 查看当前目录、模式和最近任务\n"
    f"- `{CATEGORIES_COMMAND}` 查看可用词库目录\n"
    f"- `{CD_COMMAND} daily` 切换默认目录\n"
    f"- `{SEARCH_COMMAND} laden` 查词\n\n"
    "**学习工作流**\n\n"
    f"- `{ADD_COMMAND}` 进入加词模式\n"
    f"- `{ADD_COMMAND} word | 例句 | 来源` 单次加词\n"
    f"- `{UPLOAD_COMMAND} [任务名]` 进入图片/PDF 收集模式，默认上传后自动分析\n"
    f"- `{NAME_COMMAND} 任务名` 在上传模式中修改任务名\n"
    f"- `{AUTO_COMMAND} on|off` 在上传模式中开关上传后自动分析\n"
    f"- `{PROCESS_COMMAND} [task_id]` 开始处理最近任务或指定任务\n"
    f"- `{TASK_COMMAND} [task_id]` 查看最近任务或指定任务\n"
    f"- `{REVIEW_COMMAND}` 进入复习模式\n"
    f"- `{MODE_COMMAND} 1|2|3` 设置复习题型，并记住下次默认值\n"
    f"- `{SKIP_COMMAND}` 复习时跳过当前词\n"
    f"- `{END_COMMAND}` 结束当前模式\n\n"
    "**上传 OCR 流程**\n\n"
    f"`{UPLOAD_COMMAND}` -> 发送图片/PDF -> `{END_COMMAND}` -> `{PROCESS_COMMAND}` -> `{TASK_COMMAND}`\n\n"
    "**说明**\n\n"
    "- 直接发送英文单词会自动查词。\n"
    "- `review` 支持 3 种题型：释义理解 / 场景填空 / 创意输出。\n"
    "- 自由聊天会优先尝试 LLM 路由，失败后保存为普通消息记录。"
)


def load_env_file(path: Path) -> None:
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
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]

        os.environ.setdefault(key, value)


def load_local_env() -> None:
    env_file = os.environ.get("QQ_LINKUALOG_ENV_FILE", "").strip()
    if env_file:
        load_env_file(Path(env_file).expanduser())
        return
    load_env_file(Path(DEFAULT_LINKUALOG_ENV_FILE))


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required env: {name}")
    return value


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"invalid integer env {name}={raw!r}") from exc


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise RuntimeError(f"invalid float env {name}={raw!r}") from exc


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return Path(raw).expanduser()


def collapse_ws(text: str) -> str:
    return WS_PATTERN.sub(" ", str(text or "")).strip()


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today_iso() -> str:
    return datetime.now().date().isoformat()


def normalize_command_text(text: str) -> str:
    collapsed = collapse_ws(text.replace("\u3000", " "))
    without_mentions = MENTION_PATTERN.sub(" ", collapsed)
    return collapse_ws(without_mentions)


def normalize_word_key(text: str) -> str:
    lowered = collapse_ws(text).lower()
    if not lowered:
        return ""
    return SAFE_WORD_CHARS_PATTERN.sub("-", lowered).strip("-")


def normalize_category_name(text: str) -> str:
    lowered = collapse_ws(text).lower()
    if not lowered:
        return ""
    return CATEGORY_PATTERN.sub("-", lowered).strip("-")


def normalize_json_filename(filename: str) -> str:
    name = collapse_ws(filename)
    if not name:
        return ""
    if not name.endswith(".json"):
        name = f"{name}.json"
    return os.path.basename(name)


def parse_review_mode(value: object, default: int | None = None) -> int | None:
    return review_teaching_mod.parse_review_mode(value, default)


def review_mode_label(mode: object) -> str:
    return review_teaching_mod.review_mode_label(mode)


def review_mode_description(mode: object) -> str:
    return review_teaching_mod.review_mode_description(mode)


def normalize_answer_key(text: str) -> str:
    return review_teaching_mod.normalize_answer_key(text)


def normalize_review_surface_text(text: str) -> str:
    return review_teaching_mod.normalize_review_surface_text(text)


def review_target_surface_forms(current: dict) -> list[str]:
    return review_teaching_mod.review_target_surface_forms(current)


def text_contains_review_target(current: dict, text: str) -> bool:
    return review_teaching_mod.text_contains_review_target(current, text)


def contains_cjk(text: str) -> bool:
    return review_teaching_mod.contains_cjk(text)


def looks_mostly_english(text: str) -> bool:
    return review_teaching_mod.looks_mostly_english(text)


def strip_review_noise(text: str) -> str:
    return review_teaching_mod.strip_review_noise(text)


def simple_english_lemma(token: str) -> str:
    return review_teaching_mod.simple_english_lemma(token)


def inflection_base_candidates(token: str) -> list[str]:
    return review_teaching_mod.inflection_base_candidates(token)


def cleanup_word_candidates(current: dict, example_text: str, explanation: str) -> list[str]:
    return review_teaching_mod.cleanup_word_candidates(current, example_text, explanation)


def guess_cleanup_word_candidate(current: dict, example_text: str, explanation: str) -> str:
    return review_teaching_mod.guess_cleanup_word_candidate(current, example_text, explanation)


def shorten_text(text: str, limit: int = 96) -> str:
    collapsed = collapse_ws(text)
    if len(collapsed) <= limit:
        return collapsed
    if limit <= 3:
        return collapsed[:limit]
    return collapsed[: limit - 3] + "..."


def sanitize_filename(name: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", collapse_ws(name))
    cleaned = cleaned.strip("._")
    return cleaned or fallback


def pick_review_reference_hint(current: dict, limit: int = 72) -> str:
    return review_teaching_mod.pick_review_reference_hint(current, limit)


def looks_generic_creative_task(text: str) -> bool:
    return review_teaching_mod.looks_generic_creative_task(text)


def looks_generic_creative_tip(text: str) -> bool:
    return review_teaching_mod.looks_generic_creative_tip(text)


def select_creative_review_template(current: dict) -> dict:
    return review_teaching_mod.select_creative_review_template(current)


def strip_json_fence(text: str) -> str:
    body = str(text or "").strip()
    if body.startswith("```"):
        body = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", body)
        body = re.sub(r"\s*```$", "", body)
    return body.strip()


def markdown_quote(text: str, fallback: str = "暂无") -> str:
    body = str(text or "").strip() or fallback
    return "\n".join(f"> {line}" if line else ">" for line in body.splitlines())


def parse_json_loose(text: str) -> dict:
    body = strip_json_fence(text)
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid json payload: {shorten_text(body, 160)}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("json payload must be an object")
    return parsed


def load_json_file(path: Path) -> dict | list | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None
    return payload


def write_json_file(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def http_bytes(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[bytes, dict[str, str]]:
    request_headers = {"User-Agent": f"{APP_SLUG}/1.0"}
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"network error for {url}: {exc}") from exc

    return payload, response_headers


def http_text(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> str:
    payload, response_headers = http_bytes(method, url, headers=headers, body=body, timeout=timeout)
    charset = "utf-8"
    content_type = response_headers.get("content-type", "")
    match = re.search(r"charset=([A-Za-z0-9._-]+)", content_type)
    if match:
        charset = match.group(1)
    return payload.decode(charset, errors="replace")


def http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: dict | list | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> dict:
    request_headers = dict(headers or {})
    request_body = body
    if data is not None:
        request_body = json.dumps(data).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    text = http_text(method, url, headers=request_headers, body=request_body, timeout=timeout)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON from {url}: {shorten_text(text, 200)}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"expected JSON object from {url}")
    return parsed


def build_multipart_form_data(
    fields: list[tuple[str, str]],
    files: list[tuple[str, str, bytes, str]],
) -> tuple[bytes, str]:
    boundary = f"----{APP_SLUG}-{uuid4().hex}"
    chunks: list[bytes] = []

    for name, value in fields:
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )

    for field_name, file_name, file_bytes, content_type in files:
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{field_name}"; filename="{file_name}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(file_bytes)
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), boundary


def get_access_token(app_id: str, app_secret: str) -> tuple[str, int]:
    result = http_json(
        "POST",
        TOKEN_URL,
        data={"appId": app_id, "clientSecret": app_secret},
        timeout=20.0,
    )
    token = str(result.get("access_token", "")).strip()
    expires_in = int(result.get("expires_in", 0) or 0)
    if not token:
        raise RuntimeError(f"access token missing in response: {result}")
    return token, expires_in


class TokenManager:
    def __init__(self, app_id: str, app_secret: str) -> None:
        self.app_id = app_id
        self.app_secret = app_secret
        self.access_token: str | None = None
        self.refresh_at: float = 0.0

    def get(self) -> str:
        now = time.time()
        if self.access_token and now < self.refresh_at:
            return self.access_token

        token, expires_in = get_access_token(self.app_id, self.app_secret)
        refresh_buffer = 60
        self.access_token = token
        self.refresh_at = now + max(expires_in - refresh_buffer, 1)
        print(f"[token] refreshed access token, expires_in={expires_in}s")
        return token


def get_gateway(access_token: str) -> dict:
    return http_json(
        "GET",
        GATEWAY_URL,
        headers={"Authorization": f"QQBot {access_token}"},
        timeout=20.0,
    )


def openapi_post(access_token: str, path: str, payload: dict) -> dict:
    return http_json(
        "POST",
        OPENAPI_BASE_URL + path,
        headers={"Authorization": f"QQBot {access_token}"},
        data=payload,
        timeout=20.0,
    )


class DedupCache:
    def __init__(self, max_items: int = 2048) -> None:
        self.max_items = max_items
        self._seen: set[str] = set()
        self._order: deque[str] = deque()

    def add(self, item: str) -> bool:
        if item in self._seen:
            return False
        self._seen.add(item)
        self._order.append(item)
        while len(self._order) > self.max_items:
            oldest = self._order.popleft()
            self._seen.discard(oldest)
        return True


def normalize_event(payload: dict) -> dict | None:
    event_type = payload.get("t")
    data = payload.get("d") or {}

    if event_type == "C2C_MESSAGE_CREATE":
        author = data.get("author") or {}
        return {
            "platform": "qq",
            "scene": "direct",
            "event_type": event_type,
            "connector_event_id": payload.get("id"),
            "conversation_id": author.get("user_openid"),
            "sender_id": author.get("user_openid"),
            "message_id": data.get("id"),
            "received_at": data.get("timestamp"),
            "text": data.get("content", ""),
            "attachments": data.get("attachments", []),
            "mentions_bot": False,
            "raw_payload": payload,
        }

    if event_type == "GROUP_AT_MESSAGE_CREATE":
        author = data.get("author") or {}
        return {
            "platform": "qq",
            "scene": "group",
            "event_type": event_type,
            "connector_event_id": payload.get("id"),
            "conversation_id": data.get("group_openid"),
            "sender_id": author.get("member_openid"),
            "message_id": data.get("id"),
            "received_at": data.get("timestamp"),
            "text": data.get("content", ""),
            "attachments": data.get("attachments", []),
            "mentions_bot": True,
            "raw_payload": payload,
        }

    if event_type == "FRIEND_ADD":
        return {
            "platform": "qq",
            "scene": "direct",
            "event_type": event_type,
            "connector_event_id": payload.get("id"),
            "conversation_id": data.get("openid"),
            "sender_id": data.get("openid"),
            "message_id": None,
            "received_at": data.get("timestamp"),
            "text": "",
            "attachments": [],
            "mentions_bot": False,
            "raw_payload": payload,
        }

    if event_type == "GROUP_ADD_ROBOT":
        return {
            "platform": "qq",
            "scene": "group",
            "event_type": event_type,
            "connector_event_id": payload.get("id"),
            "conversation_id": data.get("group_openid"),
            "sender_id": data.get("op_member_openid"),
            "message_id": None,
            "received_at": data.get("timestamp"),
            "text": "",
            "attachments": [],
            "mentions_bot": True,
            "raw_payload": payload,
        }

    return None


@dataclass
class ToolResult:
    tool_name: str
    reply_text: str = ""
    metadata: dict[str, object] | None = None
    should_reply: bool = True


class SessionStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        raw = load_json_file(path)
        self.state = raw if isinstance(raw, dict) else {}

    def default_session(self) -> dict:
        return {
            "mode": "idle",
            "current_category": "daily",
            "pending_confirmation": None,
            "review_preferences": {"mode": 1},
            "upload": None,
            "review": None,
            "add": None,
            "last_task_id": "",
            "last_updated_at": now_iso(),
        }

    def get(self, session_key: str) -> dict:
        payload = self.state.get(session_key)
        if not isinstance(payload, dict):
            payload = self.default_session()
            self.state[session_key] = payload
        payload.setdefault("mode", "idle")
        payload.setdefault("current_category", "daily")
        payload.setdefault("pending_confirmation", None)
        if not isinstance(payload.get("review_preferences"), dict):
            payload["review_preferences"] = {"mode": 1}
        payload["review_preferences"]["mode"] = parse_review_mode(
            payload["review_preferences"].get("mode"),
            1,
        ) or 1
        payload.setdefault("upload", None)
        payload.setdefault("review", None)
        payload.setdefault("add", None)
        payload.setdefault("last_task_id", "")
        if isinstance(payload.get("review"), dict):
            payload["review"]["mode"] = parse_review_mode(
                payload["review"].get("mode"),
                payload["review_preferences"]["mode"],
            ) or payload["review_preferences"]["mode"]
        payload["last_updated_at"] = now_iso()
        return payload

    def save(self) -> None:
        write_json_file(self.path, self.state)

    def update(self, session_key: str, payload: dict) -> None:
        payload["last_updated_at"] = now_iso()
        self.state[session_key] = payload
        self.save()


class LinkuaLogClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def _url(self, path: str, query: dict[str, str] | None = None) -> str:
        url = self.base_url + path
        if query:
            clean_query = {key: value for key, value in query.items() if value != ""}
            if clean_query:
                url += "?" + urllib.parse.urlencode(clean_query)
        return url

    def health(self) -> dict:
        return http_json("GET", self._url("/api/health"), timeout=10.0)

    def list_categories(self) -> list[str]:
        result = http_json("GET", self._url("/api/vocabulary/categories"), timeout=20.0)
        categories = result.get("categories")
        return [str(item).strip() for item in categories] if isinstance(categories, list) else []

    def add_vocabulary(
        self,
        *,
        word: str,
        category: str,
        context: str = "",
        source: str = "",
        fetch_llm: bool = False,
    ) -> dict:
        return http_json(
            "POST",
            self._url("/api/vocabulary/add"),
            data={
                "word": word,
                "context": context,
                "source": source,
                "fetch_llm": bool(fetch_llm),
                "fetch_type": "all" if context else "def",
                "category": category,
                "focus_positions": [],
                "llm_result": {},
                "youtube": {},
            },
            timeout=90.0 if fetch_llm else 30.0,
        )

    def get_vocab_detail(self, word: str, category: str) -> dict:
        return http_json(
            "GET",
            self._url(f"/api/vocabulary/detail/{urllib.parse.quote(word, safe='')}", {"category": category}),
            timeout=20.0,
        )

    def save_vocab(self, *, category: str, filename: str, data: dict) -> dict:
        return http_json(
            "POST",
            self._url("/api/vocabulary/save"),
            data={"category": category, "filename": filename, "data": data},
            timeout=30.0,
        )

    def rename_vocab(self, *, category: str, filename: str, word: str, data: dict | None = None) -> dict:
        payload: dict[str, Any] = {
            "category": category,
            "filename": filename,
            "word": word,
        }
        if isinstance(data, dict):
            payload["data"] = data
        return http_json(
            "POST",
            self._url("/api/vocabulary/rename"),
            data=payload,
            timeout=30.0,
        )

    def review_recommend(
        self,
        *,
        category: str | None,
        exclude_keys: list[str],
        limit: int = 5,
    ) -> dict:
        payload: dict[str, Any] = {"exclude_keys": exclude_keys, "limit": limit}
        if category:
            payload["category"] = category
        return http_json(
            "POST",
            self._url("/api/review/recommend"),
            data=payload,
            timeout=30.0,
        )

    def review_suggest(
        self,
        *,
        category: str,
        filename: str,
        score: int,
        auto_save: bool = True,
    ) -> dict:
        return http_json(
            "POST",
            self._url("/api/review/suggest"),
            data={
                "category": category,
                "filename": filename,
                "score": score,
                "auto_save": bool(auto_save),
            },
            timeout=30.0,
        )

    def upload_resources(
        self,
        *,
        file_paths: list[Path],
        task_name: str,
        start_page: int = 1,
        auto_process: bool = True,
    ) -> dict:
        files: list[tuple[str, str, bytes, str]] = []
        for path in file_paths:
            file_bytes = path.read_bytes()
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            files.append(("files", path.name, file_bytes, content_type))

        body, boundary = build_multipart_form_data(
            fields=[
                ("taskName", task_name),
                ("startPage", str(start_page)),
                ("autoProcess", "true" if auto_process else "false"),
            ],
            files=files,
        )
        return http_json(
            "POST",
            self._url("/api/upload_resource"),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            body=body,
            timeout=180.0,
        )

    def task_status(self, task_id: str) -> dict:
        return http_json(
            "GET",
            self._url(f"/api/task/{urllib.parse.quote(task_id, safe='')}"),
            timeout=20.0,
        )

    def resume_task(self, task_id: str) -> dict:
        return http_json(
            "POST",
            self._url(f"/api/task/{urllib.parse.quote(task_id, safe='')}/resume"),
            data={},
            timeout=20.0,
        )

    def list_tasks(self) -> list[dict]:
        result = http_json("GET", self._url("/api/tasks"), timeout=20.0)
        tasks = result.get("tasks")
        return tasks if isinstance(tasks, list) else []


class LLMClient:
    def __init__(self, *, provider: str, model: str, api_key: str, enabled: bool) -> None:
        self.provider = provider.strip()
        self.model = model.strip()
        self.api_key = api_key.strip()
        self.enabled = bool(enabled and self.provider and self.model and self.api_key)
        self.max_retries = 2

    @staticmethod
    def ensure_json_instruction(system_prompt: str, user_prompt: str) -> str:
        combined = f"{system_prompt}\n{user_prompt}"
        if "json" in combined:
            return system_prompt
        prefix = "Return valid json only. "
        return prefix + system_prompt

    @staticmethod
    def ensure_json_user_prompt(user_prompt: str) -> str:
        if "json" in user_prompt:
            return user_prompt
        prefix = "Reply with json only.\n"
        return prefix + user_prompt

    @staticmethod
    def is_json_word_requirement_error(exc: Exception) -> bool:
        message = str(exc)
        return "must contain the word 'json'" in message and "json_object" in message

    def chat_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 500,
        temperature: float = 0.1,
        timeout: float = 60.0,
    ) -> dict:
        if not self.enabled:
            raise RuntimeError("llm disabled")

        safe_system_prompt = self.ensure_json_instruction(system_prompt, user_prompt)
        safe_user_prompt = user_prompt
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": safe_system_prompt},
                {"role": "user", "content": safe_user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        last_exc: Exception | None = None
        result = None
        attempts = max(1, self.max_retries + 1)
        for attempt in range(attempts):
            request_payload = dict(payload)
            if attempt > 0:
                request_payload["messages"] = [
                    {"role": "system", "content": self.ensure_json_instruction(safe_system_prompt, safe_user_prompt)},
                    {"role": "user", "content": self.ensure_json_user_prompt(safe_user_prompt)},
                ]
            try:
                result = http_json(
                    "POST",
                    self.provider,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    data=request_payload,
                    timeout=timeout,
                )
                break
            except RuntimeError as exc:
                last_exc = exc
                if self.is_json_word_requirement_error(exc) and attempt + 1 < attempts:
                    continue
                if attempt + 1 < attempts:
                    continue
                raise
        if result is None:
            assert last_exc is not None
            raise last_exc
        choices = result.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError(f"llm choices missing: {result}")
        message = choices[0].get("message") if isinstance(choices[0], dict) else {}
        content = str(message.get("content") or "")
        if not content:
            raise RuntimeError("llm content missing")
        return parse_json_loose(content)


class QQLinkuaLogApp:
    def __init__(
        self,
        *,
        session_state_file: Path,
        local_data_dir: Path,
        linkualog_data_dir: Path,
        linkualog_client: LinkuaLogClient,
        llm_client: LLMClient,
        add_fetch_llm: bool,
        route_confidence_threshold: float,
    ) -> None:
        self.local_data_dir = local_data_dir
        self.linkualog_data_dir = linkualog_data_dir
        self.linkualog_client = linkualog_client
        self.llm_client = llm_client
        self.add_fetch_llm = add_fetch_llm
        self.route_confidence_threshold = route_confidence_threshold
        self.local_data_dir.mkdir(parents=True, exist_ok=True)
        self.session_store = SessionStore(session_state_file)

    def handle_envelope(self, envelope: dict) -> ToolResult:
        session_key = self.session_key(envelope)
        session = self.session_store.get(session_key)
        raw_text = str(envelope.get("text") or "")
        normalized_text = normalize_command_text(raw_text)

        if session.get("pending_confirmation"):
            result = self.handle_pending_confirmation(envelope, session, normalized_text)
            self.persist_session(session_key, session)
            self.log_execution(envelope, normalized_text, result)
            return result

        if self.is_command_text(normalized_text):
            result = self.handle_command(envelope, session, normalized_text)
            self.persist_session(session_key, session)
            self.log_execution(envelope, normalized_text, result)
            return result

        mode = str(session.get("mode") or "idle")
        if mode == "upload":
            result = self.handle_upload_message(envelope, session, normalized_text)
            self.persist_session(session_key, session)
            self.log_execution(envelope, normalized_text, result)
            return result
        if mode == "add":
            result = self.handle_add_message(envelope, session, normalized_text)
            self.persist_session(session_key, session)
            self.log_execution(envelope, normalized_text, result)
            return result
        if mode == "review":
            result = self.handle_review_message(envelope, session, normalized_text)
            self.persist_session(session_key, session)
            self.log_execution(envelope, normalized_text, result)
            return result

        result = self.handle_idle_message(envelope, session, normalized_text)
        self.persist_session(session_key, session)
        self.log_execution(envelope, normalized_text, result)
        return result

    def session_key(self, envelope: dict) -> str:
        scene = str(envelope.get("scene") or "direct")
        conversation_id = str(envelope.get("conversation_id") or envelope.get("sender_id") or "unknown")
        return f"{scene}:{conversation_id}"

    def persist_session(self, session_key: str, session: dict) -> None:
        self.session_store.update(session_key, session)

    def log_execution(self, envelope: dict, normalized_text: str, result: ToolResult) -> None:
        path = self.local_data_dir / "execution_logs" / f"{today_iso()}.jsonl"
        append_jsonl(
            path,
            {
                "executed_at": now_iso(),
                "tool_name": result.tool_name,
                "status": (result.metadata or {}).get("status"),
                "message_id": envelope.get("message_id"),
                "scene": envelope.get("scene"),
                "event_type": envelope.get("event_type"),
                "sender_id": envelope.get("sender_id"),
                "conversation_id": envelope.get("conversation_id"),
                "input_text": normalized_text,
                "reply_text": result.reply_text,
                "should_reply": result.should_reply,
                "metadata": result.metadata or {},
            },
        )

    def reply(self, tool_name: str, text: str, **metadata: object) -> ToolResult:
        return ToolResult(tool_name=tool_name, reply_text=text, metadata=metadata, should_reply=True)

    def reply_md(self, tool_name: str, text: str, **metadata: object) -> ToolResult:
        metadata["message_format"] = "markdown"
        return self.reply(tool_name, text, **metadata)

    def silent(self, tool_name: str, **metadata: object) -> ToolResult:
        return ToolResult(tool_name=tool_name, reply_text="", metadata=metadata, should_reply=False)

    def get_review_preferences(self, session: dict) -> dict:
        preferences = session.get("review_preferences")
        if not isinstance(preferences, dict):
            preferences = {"mode": 1}
            session["review_preferences"] = preferences
        preferences["mode"] = parse_review_mode(preferences.get("mode"), 1) or 1
        return preferences

    def get_active_review_mode(self, session: dict) -> int:
        review = session.get("review") if isinstance(session.get("review"), dict) else None
        if review:
            review["mode"] = parse_review_mode(
                review.get("mode"),
                self.get_review_preferences(session).get("mode", 1),
            ) or 1
            return int(review["mode"])
        return int(self.get_review_preferences(session).get("mode", 1) or 1)

    def combine_markdown_reply(
        self,
        tool_name: str,
        lead_text: str,
        next_result: ToolResult | None = None,
        **metadata: object,
    ) -> ToolResult:
        parts = [str(lead_text or "").strip()]
        merged_metadata = dict(next_result.metadata or {}) if next_result else {}
        merged_metadata.update(metadata)
        if next_result and next_result.should_reply and next_result.reply_text:
            parts.append(str(next_result.reply_text).strip())
        return self.reply_md(
            tool_name,
            "\n\n".join(part for part in parts if part),
            **merged_metadata,
        )

    def handle_pending_confirmation(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        lowered = normalized_text.lower()
        pending = session.get("pending_confirmation") or {}
        if lowered in YES_WORDS:
            session["pending_confirmation"] = None
            plan = pending.get("plan") if isinstance(pending, dict) else None
            if isinstance(plan, dict):
                return self.execute_idle_plan(session, envelope, normalized_text, plan)
            return self.reply("confirm_execute", "当前没有需要确认的敏感动作。", status="noop")
        if lowered in NO_WORDS:
            session["pending_confirmation"] = None
            return self.reply(
                "confirm_cancel",
                f"已取消待确认动作：{pending.get('summary', 'unknown')}",
                status="cancelled",
            )
        return self.reply(
            "confirm_wait",
            "有待确认动作。回复 y/1 确认，回复 n/0 取消。",
            status="waiting",
        )

    def is_command_text(self, normalized_text: str) -> bool:
        return normalized_text.startswith(COMMAND_PREFIX)

    def handle_command(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        command, argument = self.split_command(normalized_text)
        mode = str(session.get("mode") or "idle")

        if command == PING_COMMAND:
            scene = "群聊" if envelope.get("scene") == "group" else "单聊"
            return self.reply("ping", f"{scene} pong", status="success")

        if command == HELP_COMMAND:
            return self.reply("help", HELP_TEXT, status="success", message_format="markdown")

        if command == STATUS_COMMAND:
            return self.reply_md("status", self.build_status_text(session), status="success")

        if command == CATEGORIES_COMMAND:
            return self.reply_md("categories", self.build_categories_text(), status="success")

        if command == CD_COMMAND:
            return self.change_category(session, argument)

        if command == SEARCH_COMMAND:
            return self.search_vocab(argument, session.get("current_category", "daily"))

        if command == MODE_COMMAND:
            return self.set_review_mode(session, argument)

        if command == TASK_COMMAND:
            return self.show_task_status(session, argument)

        if command == PROCESS_COMMAND:
            return self.process_task(session, argument)

        if command == END_COMMAND:
            return self.end_mode(session)

        if command == NAME_COMMAND:
            if mode != "upload":
                return self.reply("upload_name_invalid", f"{NAME_COMMAND} 只能在 [upload] 模式中使用。", status="error")
            return self.rename_upload_task(session, argument)

        if command == AUTO_COMMAND:
            if mode != "upload":
                return self.reply("upload_auto_invalid", f"{AUTO_COMMAND} 只能在 [upload] 模式中使用。", status="error")
            return self.set_upload_auto_process(session, argument)

        if command == SKIP_COMMAND:
            if mode != "review":
                return self.reply("skip_invalid", "当前不在 [review] 模式。", status="error")
            return self.skip_review_item(session)

        if command == UPLOAD_COMMAND:
            if mode == "upload":
                if argument:
                    return self.rename_upload_task(session, argument)
                return self.reply(
                    "upload_active",
                    f"当前已经在 [upload] 模式。可发 {NAME_COMMAND} 任务名 修改名称，发 {AUTO_COMMAND} on|off 设置自动分析，发 {END_COMMAND} 结束。",
                    status="active",
                )
            if mode != "idle":
                return self.reply("upload_blocked", f"当前已有活跃模式，请先 {END_COMMAND} 退出。", status="error")
            return self.start_upload_mode(session, argument)

        if command == ADD_COMMAND:
            if mode != "idle":
                return self.reply("add_blocked", f"当前已有活跃模式，请先 {END_COMMAND} 退出。", status="error")
            if argument:
                return self.add_one_shot(envelope, session, argument)
            return self.start_add_mode(session)

        if command == REVIEW_COMMAND:
            if mode != "idle":
                return self.reply("review_blocked", f"当前已有活跃模式，请先 {END_COMMAND} 退出。", status="error")
            return self.start_review_mode(session, argument)

        return self.reply("unknown_command", f"未知命令：{command}。发 {HELP_COMMAND} 查看可用命令。", status="error")

    def split_command(self, normalized_text: str) -> tuple[str, str]:
        if not normalized_text:
            return "", ""
        parts = normalized_text.split(" ", 1)
        command = parts[0].strip().lower()
        argument = parts[1].strip() if len(parts) > 1 else ""
        return command, argument

    def build_status_text(self, session: dict) -> str:
        mode = str(session.get("mode") or "idle")
        current_category = str(session.get("current_category") or "daily")
        default_review_mode = self.get_active_review_mode(session)
        lines = [
            "### 当前状态",
            "",
            f"- 当前目录: `{current_category}`",
            f"- 当前模式: `{mode}`",
            f"- 默认复习题型: `模式 {default_review_mode} · {review_mode_label(default_review_mode)}`",
        ]

        upload = session.get("upload") if isinstance(session.get("upload"), dict) else None
        if upload:
            task_name = collapse_ws(str(upload.get("task_name") or "未命名任务"))
            auto_process = bool(upload.get("auto_process", True))
            lines.extend(
                [
                    "",
                    "### Upload",
                    "",
                    f"- 任务名: **{task_name}**",
                    f"- 已收集文件: `{len(upload.get('files', []))}`",
                    f"- 文本备注: `{len(upload.get('notes', []))}`",
                    f"- 自动分析: `{'开' if auto_process else '关'}`",
                ]
            )

        review = session.get("review") if isinstance(session.get("review"), dict) else None
        if review:
            current = review.get("current") if isinstance(review.get("current"), dict) else None
            review_mode = parse_review_mode(review.get("mode"), default_review_mode) or default_review_mode
            lines.extend(
                [
                    "",
                    "### Review",
                    "",
                    f"- 当前题型: `模式 {review_mode} · {review_mode_label(review_mode)}`",
                    f"- 已排除词条: `{len(review.get('excluded_keys', []))}`",
                ]
            )
            if current:
                lines.append(f"- 当前词条: **{current.get('word', '')}** `[{current.get('category', '')}]`")
            pending_cleanup = review.get("pending_cleanup") if isinstance(review.get("pending_cleanup"), dict) else None
            if pending_cleanup:
                lines.append(f"- 脏内容提醒: `待确认` ({'；'.join(pending_cleanup.get('issues', [])[:3])})")

        last_task_id = str(session.get("last_task_id") or "").strip()
        if last_task_id:
            lines.append(f"- 最近任务: `{last_task_id}`")

        pending = session.get("pending_confirmation")
        if isinstance(pending, dict) and pending:
            lines.append(f"- 待确认动作: `{pending.get('summary', 'unknown')}`")
        return "\n".join(lines)

    def build_categories_text(self) -> str:
        categories = self.safe_list_categories()
        if not categories:
            return "当前没有可用目录。"
        lines = ["### 可用词库目录", ""]
        for item in categories[:20]:
            lines.append(f"- `{item}`")
        if len(categories) > 20:
            lines.extend(["", f"_仅显示前 20 个，当前共 {len(categories)} 个目录。_"])
        return "\n".join(lines)

    def format_review_mode_help(self, mode: int, *, active: bool) -> str:
        lines = [
            "### 复习题型",
            "",
            f"- 当前默认: `模式 {mode} · {review_mode_label(mode)}`",
        ]
        if active:
            lines.append("- 这次切换会立刻作用到当前复习题。")
        else:
            lines.append(f"- 下次发 `{REVIEW_COMMAND}` 会直接用这个模式。")
        lines.extend(
            [
                "",
                f"- `{MODE_COMMAND} 1` 释义理解",
                f"- `{MODE_COMMAND} 2` 场景填空",
                f"- `{MODE_COMMAND} 3` 创意输出",
            ]
        )
        return "\n".join(lines)

    def safe_list_categories(self) -> list[str]:
        try:
            categories = self.linkualog_client.list_categories()
        except Exception:
            categories = []
        if categories:
            return categories

        if self.linkualog_data_dir.exists():
            return sorted(path.name for path in self.linkualog_data_dir.iterdir() if path.is_dir())
        return []

    def set_review_mode(self, session: dict, raw_argument: str) -> ToolResult:
        current_mode = self.get_active_review_mode(session)
        mode = parse_review_mode(raw_argument)
        review = session.get("review") if isinstance(session.get("review"), dict) else None

        if mode is None:
            return self.reply_md(
                "review_mode",
                self.format_review_mode_help(current_mode, active=bool(review)),
                status="noop",
                mode=current_mode,
            )

        preferences = self.get_review_preferences(session)
        preferences["mode"] = mode

        if not review:
            return self.reply_md(
                "review_mode",
                (
                    "### 已更新复习题型\n\n"
                    f"- 当前默认: `模式 {mode} · {review_mode_label(mode)}`\n"
                    f"- 说明: {review_mode_description(mode)}\n\n"
                    f"下次发 `{REVIEW_COMMAND}` 会直接使用这个模式。"
                ),
                status="success",
                mode=mode,
            )

        review["mode"] = mode
        current = review.get("current")
        if isinstance(current, dict):
            current.pop("challenge", None)

        if isinstance(review.get("pending_cleanup"), dict):
            review["pending_cleanup"] = None
            next_result = self.prepare_next_review_prompt(session, intro=False)
            return self.combine_markdown_reply(
                "review_mode",
                (
                    "### 已更新复习题型\n\n"
                    f"- 当前题型: `模式 {mode} · {review_mode_label(mode)}`\n"
                    "- 上一题的清理请求已按未同意处理。"
                ),
                next_result,
                status="success",
                mode=mode,
            )

        return self.prepare_current_review_prompt(
            session,
            intro=False,
            note=f"已切到模式 {mode} · {review_mode_label(mode)}。",
        )

    def change_category(self, session: dict, raw_argument: str) -> ToolResult:
        category = normalize_category_name(raw_argument)
        if not category:
            return self.reply("cd_invalid", f"用法: {CD_COMMAND} 目录名", status="error")

        categories = self.safe_list_categories()
        session["current_category"] = category
        review = session.get("review")
        if isinstance(review, dict) and review.get("scope_kind") == "category":
            review["category"] = category

        if categories and category not in categories:
            return self.reply(
                "cd",
                f"当前目录已切换到 {category}。\n该目录暂未出现在 linkualog 中，会在首次写入时创建。",
                status="success",
                category=category,
                category_exists=False,
            )

        return self.reply(
            "cd",
            f"当前目录已切换到 {category}",
            status="success",
            category=category,
            category_exists=True,
        )

    def search_vocab(self, raw_query: str, current_category: str) -> ToolResult:
        query = normalize_word_key(raw_query)
        if not query:
            return self.reply("search_vocab", f"查词格式: {SEARCH_COMMAND} laden", status="error")

        matches = self.search_linkualog_vocab(query, preferred_category=current_category)
        if not matches:
            return self.reply_md(
                "search_vocab",
                (
                    "### 查词结果\n\n"
                    f"- 查询: `{query}`\n"
                    "- 结果: 暂未找到\n\n"
                    f"可用 `{ADD_COMMAND}` 进入添加模式。"
                ),
                status="not_found",
                query=query,
            )

        lines = ["### 查词结果", "", f"- 查询: `{query}`", f"- 命中: `{len(matches)}`", ""]
        for index, item in enumerate(matches, start=1):
            definition = shorten_text(item["definition_preview"], 56) if item["definition_preview"] else "暂无释义"
            lines.extend(
                [
                    f"{index}. **{item['word']}**",
                    f"- 目录: `{item['category']}`",
                    f"- 内容: definitions `{item['definition_count']}` · examples `{item['example_count']}` · marked `{item['marked']}`",
                    f"- 释义预览: {definition}",
                    "",
                ]
            )
        return self.reply_md(
            "search_vocab",
            "\n".join(lines).rstrip(),
            status="success",
            query=query,
            match_count=len(matches),
        )

    def search_linkualog_vocab(self, query: str, preferred_category: str = "", limit: int = 3) -> list[dict]:
        if not query or not self.linkualog_data_dir.exists():
            return []

        candidates: list[dict] = []
        for category_dir in sorted(self.linkualog_data_dir.iterdir()):
            if not category_dir.is_dir():
                continue
            for path in sorted(category_dir.glob("*.json")):
                stem_key = normalize_word_key(path.stem)
                score = 0
                if query == stem_key:
                    score = 300
                elif stem_key.startswith(query):
                    score = 220
                elif query in stem_key:
                    score = 180
                else:
                    continue

                if preferred_category and category_dir.name == preferred_category:
                    score += 15

                payload = load_json_file(path)
                if not isinstance(payload, dict):
                    continue

                word = collapse_ws(str(payload.get("word") or path.stem)) or path.stem
                definitions = payload.get("definitions") if isinstance(payload.get("definitions"), list) else []
                examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []
                definition_preview = ""
                for item in definitions:
                    if isinstance(item, str) and collapse_ws(item):
                        definition_preview = collapse_ws(item)
                        break

                candidates.append(
                    {
                        "score": score,
                        "category": category_dir.name,
                        "word": word,
                        "definition_preview": definition_preview,
                        "definition_count": len(definitions),
                        "example_count": len(examples),
                        "marked": bool(payload.get("marked", False)),
                        "path": str(path),
                    }
                )

        candidates.sort(key=lambda item: (-int(item["score"]), item["category"], item["word"]))
        return candidates[:limit]

    def show_task_status(self, session: dict, raw_argument: str) -> ToolResult:
        task_id = collapse_ws(raw_argument)
        if not task_id:
            return self.show_task_list(session)

        try:
            result = self.linkualog_client.task_status(task_id)
        except Exception as exc:
            return self.reply("task_status", f"读取任务失败: {exc}", status="error", task_id=task_id)

        if result.get("error"):
            return self.reply("task_status", f"任务不存在: {task_id}", status="error", task_id=task_id)

        status = str(result.get("status") or "unknown")
        total = int(result.get("total", 0) or 0)
        completed = int(result.get("completed", 0) or 0)
        auto_process = bool(result.get("auto_process", True))
        start_page = int(result.get("start_page", 1) or 1)
        return self.reply_md(
            "task_status",
            (
                "### 任务状态\n\n"
                f"- ID: `{task_id}`\n"
                f"- 名称: **{result.get('name', '未命名任务')}**\n"
                f"- 状态: `{status}`\n"
                f"- 进度: `{completed}/{total}`\n"
                f"- 起始页: `{start_page}`\n"
                f"- 自动分析: `{'是' if auto_process else '否'}`"
            ),
            status="success",
            task_id=task_id,
        )

    def show_task_list(self, session: dict, limit: int = 8) -> ToolResult:
        try:
            tasks = self.linkualog_client.list_tasks()
        except Exception as exc:
            return self.reply("task_list", f"读取任务列表失败: {exc}", status="error")

        if not tasks:
            return self.reply(
                "task_list",
                f"当前没有任务。\n\n可以先发 `{UPLOAD_COMMAND}` 创建图片/PDF 收集任务。",
                status="empty",
                message_format="markdown",
            )

        lines = ["### 最近任务", ""]
        for index, item in enumerate(tasks[:limit], start=1):
            if not isinstance(item, dict):
                continue
            task_id = collapse_ws(str(item.get("id") or ""))
            if index == 1 and task_id:
                session["last_task_id"] = task_id
            name = collapse_ws(str(item.get("name") or "未命名任务"))
            status = collapse_ws(str(item.get("status") or "unknown"))
            total = int(item.get("total", 0) or 0)
            completed = int(item.get("completed", 0) or 0)
            lines.append(f"{index}. **{name}**")
            lines.append(f"   - 状态: `{status}`")
            lines.append(f"   - 进度: `{completed}/{total}`")
            lines.append(f"   - ID: `{task_id}`")
            lines.append(f"   - 查看: `{TASK_COMMAND} {task_id}`")
            lines.append(f"   - 处理: `{PROCESS_COMMAND} {task_id}`")
            lines.append("")

        if len(tasks) > limit:
            lines.append(f"只显示最近 {limit} 个，共 {len(tasks)} 个任务。")

        return self.reply(
            "task_list",
            "\n".join(lines).rstrip(),
            status="success",
            task_count=len(tasks),
            message_format="markdown",
        )

    def process_task(self, session: dict, raw_argument: str) -> ToolResult:
        task_id = collapse_ws(raw_argument) or collapse_ws(str(session.get("last_task_id") or ""))
        if not task_id:
            return self.reply("process_task", f"用法: {PROCESS_COMMAND} 任务ID", status="error")

        try:
            result = self.linkualog_client.resume_task(task_id)
        except Exception as exc:
            return self.reply("process_task", f"启动分析失败: {exc}", status="error", task_id=task_id)

        session["last_task_id"] = task_id
        return self.reply_md(
            "process_task",
            (
                "### 已提交处理请求\n\n"
                f"- 任务 ID: `{task_id}`\n"
                f"- 查看进度: `{TASK_COMMAND} {task_id}`"
            ),
            status="success",
            task_id=task_id,
            api_result=result,
        )

    def end_mode(self, session: dict) -> ToolResult:
        mode = str(session.get("mode") or "idle")
        if mode == "idle":
            return self.reply("end_mode", "当前没有活跃模式。", status="noop")

        if mode == "upload":
            return self.finalize_upload_mode(session)
        session["mode"] = "idle"
        session["upload"] = None
        session["review"] = None
        session["add"] = None
        return self.reply("end_mode", f"已退出 [{mode}] 模式。", status="success", mode=mode)

    def start_upload_mode(self, session: dict, raw_argument: str) -> ToolResult:
        task_name = collapse_ws(raw_argument) or f"QQ 收集 {today_iso()}"
        staging_id = uuid4().hex[:12]
        staging_dir = self.local_data_dir / "upload_staging" / staging_id
        staging_dir.mkdir(parents=True, exist_ok=True)
        session["mode"] = "upload"
        session["upload"] = {
            "task_name": task_name,
            "staging_dir": str(staging_dir),
            "files": [],
            "notes": [],
            "auto_process": True,
            "started_at": now_iso(),
        }
        return self.reply_md(
            "start_upload",
            (
                "### 已进入 Upload 模式\n\n"
                f"- 任务名: **{task_name}**\n"
                "- 默认行为: 上传结束后自动开始分析\n"
                f"- 改名: `{NAME_COMMAND} 任务名`\n"
                f"- 关闭自动分析: `{AUTO_COMMAND} off`\n"
                f"- 结束收集: `{END_COMMAND}`\n\n"
                "现在开始发图片 / PDF / 文件即可，我会先静默收集。"
            ),
            status="success",
            mode="upload",
            task_name=task_name,
            auto_process=True,
        )

    def rename_upload_task(self, session: dict, raw_argument: str) -> ToolResult:
        upload = session.get("upload") if isinstance(session.get("upload"), dict) else None
        if not upload:
            session["mode"] = "idle"
            return self.reply("upload_name", "upload 状态异常，已回到 idle。", status="error")

        task_name = collapse_ws(raw_argument)
        if not task_name:
            current_name = collapse_ws(str(upload.get("task_name") or "未命名任务"))
            return self.reply("upload_name", f"当前任务名: {current_name}\n用法: {NAME_COMMAND} 任务名", status="noop")

        upload["task_name"] = task_name
        return self.reply("upload_name", f"已把当前上传任务命名为: {task_name}", status="success", task_name=task_name)

    def set_upload_auto_process(self, session: dict, raw_argument: str) -> ToolResult:
        upload = session.get("upload") if isinstance(session.get("upload"), dict) else None
        if not upload:
            session["mode"] = "idle"
            return self.reply("upload_auto", "upload 状态异常，已回到 idle。", status="error")

        value = collapse_ws(raw_argument).lower()
        if not value:
            current = bool(upload.get("auto_process", True))
            return self.reply(
                "upload_auto",
                f"当前上传后自动分析: {'开启' if current else '关闭'}\n用法: {AUTO_COMMAND} on|off",
                status="noop",
                auto_process=current,
            )

        if value in ON_WORDS:
            upload["auto_process"] = True
        elif value in OFF_WORDS:
            upload["auto_process"] = False
        else:
            return self.reply("upload_auto", f"用法: {AUTO_COMMAND} on|off", status="error")

        enabled = bool(upload.get("auto_process", True))
        return self.reply(
            "upload_auto",
            f"上传后自动分析已{'开启' if enabled else '关闭'}。",
            status="success",
            auto_process=enabled,
        )

    def handle_upload_message(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        upload = session.get("upload") if isinstance(session.get("upload"), dict) else None
        if not upload:
            session["mode"] = "idle"
            return self.reply("upload_recover", "upload 状态异常，已回到 idle。", status="error")

        if normalized_text:
            upload.setdefault("notes", []).append(
                {
                    "message_id": envelope.get("message_id"),
                    "received_at": envelope.get("received_at"),
                    "text": normalized_text,
                }
            )

        attachments = self.extract_attachment_candidates(envelope)
        if attachments:
            staging_dir = Path(str(upload.get("staging_dir") or ""))
            saved_items = upload.setdefault("files", [])
            for attachment in attachments:
                try:
                    saved = self.download_attachment(attachment, staging_dir)
                except Exception as exc:
                    saved_items.append({"error": str(exc), "source_url": attachment.get("url", "")})
                    continue
                saved_items.append(saved)

        return self.silent(
            "upload_collect",
            status="success",
            collected_files=len(upload.get("files", [])),
            collected_notes=len(upload.get("notes", [])),
        )

    def extract_attachment_candidates(self, envelope: dict) -> list[dict]:
        attachments = envelope.get("attachments")
        if not isinstance(attachments, list):
            return []

        candidates = []
        for index, raw in enumerate(attachments):
            if not isinstance(raw, dict):
                continue
            url = ""
            for key in ATTACHMENT_URL_KEYS:
                value = raw.get(key)
                if isinstance(value, str) and value.strip():
                    url = value.strip()
                    break
            if url.startswith("//"):
                url = "https:" + url
            if not url:
                continue

            filename = ""
            for key in ATTACHMENT_NAME_KEYS:
                value = raw.get(key)
                if isinstance(value, str) and value.strip():
                    filename = value.strip()
                    break
            if not filename:
                parsed = urllib.parse.urlparse(url)
                filename = Path(parsed.path).name or f"attachment-{index}"

            content_type = ""
            for key in ATTACHMENT_MIME_KEYS:
                value = raw.get(key)
                if isinstance(value, str) and value.strip():
                    content_type = value.strip()
                    break

            candidates.append(
                {
                    "url": url,
                    "filename": sanitize_filename(filename, f"attachment-{index}"),
                    "content_type": content_type,
                    "raw": raw,
                }
            )

        return candidates

    def download_attachment(self, attachment: dict, staging_dir: Path) -> dict:
        url = str(attachment.get("url") or "").strip()
        if not url:
            raise RuntimeError("missing attachment url")
        staging_dir.mkdir(parents=True, exist_ok=True)
        filename = sanitize_filename(str(attachment.get("filename") or ""), "attachment")
        suffix = Path(filename).suffix
        content_type = str(attachment.get("content_type") or "").strip()
        if not suffix and content_type:
            suffix = mimetypes.guess_extension(content_type.split(";", 1)[0].strip()) or ""
            filename += suffix

        target = staging_dir / f"{uuid4().hex[:8]}_{filename}"
        file_bytes, response_headers = http_bytes("GET", url, timeout=60.0)
        target.write_bytes(file_bytes)
        final_content_type = content_type or response_headers.get("content-type", "").split(";", 1)[0].strip()
        return {
            "local_path": str(target),
            "original_name": filename,
            "size": len(file_bytes),
            "content_type": final_content_type,
            "url": url,
        }

    def cleanup_upload_state(self, session: dict) -> None:
        upload = session.get("upload")
        if not isinstance(upload, dict):
            return
        staging_dir = Path(str(upload.get("staging_dir") or ""))
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

    def finalize_upload_mode(self, session: dict) -> ToolResult:
        upload = session.get("upload") if isinstance(session.get("upload"), dict) else None
        if not upload:
            session["mode"] = "idle"
            return self.reply("upload_finalize", "upload 状态异常，已退出。", status="error")

        file_items = [item for item in upload.get("files", []) if isinstance(item, dict) and item.get("local_path")]
        task_name = collapse_ws(str(upload.get("task_name") or f"QQ 收集 {today_iso()}"))
        auto_process = bool(upload.get("auto_process", True))
        if not file_items:
            self.cleanup_upload_state(session)
            session["mode"] = "idle"
            session["upload"] = None
            return self.reply("upload_finalize", "已退出 [upload]，但没有收到可上传的文件。", status="error")

        try:
            result = self.linkualog_client.upload_resources(
                file_paths=[Path(str(item["local_path"])) for item in file_items],
                task_name=task_name,
                start_page=1,
                auto_process=auto_process,
            )
        except Exception as exc:
            return self.reply("upload_finalize", f"提交到 linkualog 失败: {exc}", status="error")

        task_id = str(result.get("task_id") or "").strip()
        total = int(result.get("total", len(file_items)) or len(file_items))
        session["last_task_id"] = task_id
        self.cleanup_upload_state(session)
        session["mode"] = "idle"
        session["upload"] = None
        return self.reply_md(
            "upload_finalize",
            (
                "### Upload 已完成\n\n"
                f"- 文件数: `{len(file_items)}`\n"
                f"- 总页数: `{total}`\n"
                f"- 任务名: **{task_name}**\n"
                f"- 任务 ID: `{task_id}`\n\n"
                + (
                    f"已自动开始分析，可发 `{TASK_COMMAND} {task_id}` 查看进度。"
                    if auto_process
                    else f"当前不会自动分析。需要处理时可发 `{PROCESS_COMMAND} {task_id}`。"
                )
            ),
            status="success",
            task_id=task_id,
            task_name=task_name,
            total=total,
            auto_process=auto_process,
        )

    def start_add_mode(self, session: dict) -> ToolResult:
        session["mode"] = "add"
        session["add"] = {
            "started_at": now_iso(),
            "added_count": 0,
        }
        category = str(session.get("current_category") or "daily")
        return self.reply_md(
            "start_add",
            (
                "### 已进入 Add 模式\n\n"
                f"- 当前目录: `{category}`\n"
                f"- 输入格式: `word` 或 `word | 例句 | 来源`\n"
                f"- 退出: `{END_COMMAND}`"
            ),
            status="success",
            mode="add",
            category=category,
        )

    def add_one_shot(self, envelope: dict, session: dict, raw_argument: str) -> ToolResult:
        parsed = self.parse_add_message(raw_argument)
        if not parsed:
            return self.reply("add_once", f"格式: {ADD_COMMAND} word | 例句 | 来源", status="error")
        return self.add_vocab_entry(session, parsed, source_fallback=f"QQ {ADD_COMMAND}")

    def handle_add_message(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        parsed = self.parse_add_message(normalized_text)
        if not parsed:
            return self.reply("add_mode", "请发送 `word` 或 `word | 例句 | 来源`。", status="error")

        result = self.add_vocab_entry(session, parsed, source_fallback="QQ add mode")
        add_state = session.get("add")
        if isinstance(add_state, dict) and (result.metadata or {}).get("status") == "success":
            add_state["added_count"] = int(add_state.get("added_count", 0) or 0) + 1
        return result

    def parse_add_message(self, text: str) -> dict | None:
        parts = [collapse_ws(part) for part in re.split(r"\s*[|｜]\s*", text)]
        while parts and not parts[-1]:
            parts.pop()
        if not parts:
            return None

        word = normalize_word_key(parts[0])
        if not word:
            return None
        context = parts[1] if len(parts) > 1 else ""
        source = " | ".join(parts[2:]) if len(parts) > 2 else ""
        return {"word": word, "context": context, "source": source}

    def add_vocab_entry(self, session: dict, parsed: dict, source_fallback: str) -> ToolResult:
        word = str(parsed.get("word") or "").strip()
        if not word:
            return self.reply("add_vocab", "缺少词条名。", status="error")

        category = str(session.get("current_category") or "daily")
        context = collapse_ws(str(parsed.get("context") or ""))
        source = collapse_ws(str(parsed.get("source") or "")) or source_fallback
        try:
            result = self.linkualog_client.add_vocabulary(
                word=word,
                category=category,
                context=context,
                source=source,
                fetch_llm=bool(self.add_fetch_llm and context),
            )
        except Exception as exc:
            return self.reply("add_vocab", f"写入 linkualog 失败: {exc}", status="error")

        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        definition_count = len(data.get("definitions", [])) if isinstance(data.get("definitions"), list) else 0
        example_count = len(data.get("examples", [])) if isinstance(data.get("examples"), list) else 0
        return self.reply_md(
            "add_vocab",
            (
                "### 已写入词条\n\n"
                f"- 单词: **{word}**\n"
                f"- 目录: `{category}`\n"
                f"- Definitions: `{definition_count}`\n"
                f"- Examples: `{example_count}`"
            ),
            status="success",
            word=word,
            category=category,
            definition_count=definition_count,
            example_count=example_count,
        )

    def start_review_mode(self, session: dict, raw_argument: str) -> ToolResult:
        scope = collapse_ws(raw_argument)
        current_category = str(session.get("current_category") or "daily")
        review_mode = int(self.get_review_preferences(session).get("mode", 1) or 1)
        review_state = {
            "started_at": now_iso(),
            "excluded_keys": [],
            "history": [],
            "current": None,
            "pending_cleanup": None,
            "mode": review_mode,
            "scope_kind": "all" if scope.lower() in {"all", "*"} else "category",
            "category": current_category if not scope else normalize_category_name(scope),
        }
        if review_state["scope_kind"] == "category" and not review_state["category"]:
            review_state["category"] = current_category

        session["mode"] = "review"
        session["review"] = review_state
        return self.prepare_next_review_prompt(session, intro=True)

    def prepare_next_review_prompt(self, session: dict, intro: bool = False) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_prepare", "review 状态异常，已退出。", status="error")

        category = str(review.get("category") or "")
        if str(review.get("scope_kind") or "") == "all":
            category = ""

        try:
            recommend = self.linkualog_client.review_recommend(
                category=category or None,
                exclude_keys=[str(item) for item in review.get("excluded_keys", []) if REVIEW_KEY_PATTERN.match(str(item))],
                limit=5,
            )
        except Exception as exc:
            session["mode"] = "idle"
            session["review"] = None
            return self.reply("review_prepare", f"读取复习建议失败: {exc}", status="error")

        item = recommend.get("recommended") if isinstance(recommend.get("recommended"), dict) else None
        if not item:
            session["mode"] = "idle"
            session["review"] = None
            return self.reply("review_prepare", "当前没有可复习词条，已退出 [review]。", status="success")

        category_name = str(item.get("category") or "").strip()
        file_name = normalize_json_filename(str(item.get("file") or ""))
        word_key = os.path.splitext(file_name)[0]

        try:
            detail = self.linkualog_client.get_vocab_detail(word_key, category_name)
        except Exception as exc:
            review.setdefault("excluded_keys", []).append(str(item.get("key") or ""))
            return self.reply("review_prepare", f"读取词条失败，已跳过: {exc}", status="error")

        data = detail.get("data") if isinstance(detail.get("data"), dict) else {}
        current = self.build_review_item(item, data)
        review["current"] = current
        review["pending_cleanup"] = None
        return self.prepare_current_review_prompt(session, intro=intro)

    def build_review_item(self, item: dict, data: dict) -> dict:
        examples = data.get("examples") if isinstance(data.get("examples"), list) else []
        chosen_example = {}
        chosen_index = -1
        for index, example in enumerate(examples):
            if isinstance(example, dict) and collapse_ws(example.get("text", "")):
                chosen_example = example
                chosen_index = index
                break
        if not chosen_example:
            for index, example in enumerate(examples):
                if isinstance(example, dict):
                    chosen_example = example
                    chosen_index = index
                    break
        if not chosen_example:
            chosen_example = {"text": "", "explanation": ""}

        file_name = normalize_json_filename(str(item.get("file") or ""))
        return {
            "key": str(item.get("key") or ""),
            "category": str(item.get("category") or ""),
            "file": file_name,
            "word_key": os.path.splitext(file_name)[0],
            "word": collapse_ws(str(item.get("word") or data.get("word") or "")),
            "definitions": [
                collapse_ws(str(definition))
                for definition in (data.get("definitions") if isinstance(data.get("definitions"), list) else [])
                if collapse_ws(str(definition))
            ],
            "example_index": chosen_index,
            "example_text": collapse_ws(str(chosen_example.get("text") or "")),
            "example_explanation": collapse_ws(str(chosen_example.get("explanation") or "")),
            "focus_words": [
                collapse_ws(str(focus))
                for focus in (chosen_example.get("focusWords") if isinstance(chosen_example.get("focusWords"), list) else [])
                if collapse_ws(str(focus))
            ],
            "example_source": dict(chosen_example.get("source") or {}) if isinstance(chosen_example.get("source"), dict) else {},
            "reason": collapse_ws(str(item.get("reason") or "")),
            "advice": item.get("advice") if isinstance(item.get("advice"), dict) else {},
            "challenge": None,
        }

    def inspect_review_content_issues(self, current: dict) -> dict | None:
        raw_example_index = current.get("example_index", -1)
        try:
            example_index = int(raw_example_index)
        except (TypeError, ValueError):
            example_index = -1
        if example_index < 0:
            return None

        example_text = str(current.get("example_text") or "")
        explanation = str(current.get("example_explanation") or "")
        issues: list[str] = []
        severity = 0

        example_has_noise = bool(REVIEW_NOISE_MARKER_PATTERN.search(example_text))
        explanation_has_noise = bool(REVIEW_NOISE_MARKER_PATTERN.search(explanation))
        example_transcript = bool(REVIEW_TRANSCRIPT_PATTERN.search(example_text) or REVIEW_SPEAKER_PREFIX_PATTERN.search(example_text))
        explanation_transcript = bool(REVIEW_TRANSCRIPT_PATTERN.search(explanation) or REVIEW_SPEAKER_PREFIX_PATTERN.search(explanation))
        explanation_mostly_english = looks_mostly_english(explanation)

        if not collapse_ws(example_text):
            issues.append("例句为空")
            severity += 3
        if not collapse_ws(explanation):
            issues.append("explanation 为空")
            severity += 3
        if example_transcript:
            issues.append("例句像转录稿，带说话人标记")
            severity += 2
        if explanation_transcript:
            issues.append("explanation 带说话人标记")
            severity += 2
        if example_has_noise or explanation_has_noise:
            issues.append("内容里有编号、链接或杂质标记")
            severity += 1
        if explanation_mostly_english:
            issues.append("explanation 基本是英文，不利于当前中文记忆")
            severity += 3
        if len(example_text) > 240 and (example_transcript or example_has_noise):
            issues.append("例句过长，建议精简")
            severity += 2
        if len(explanation) > 180 and (explanation_transcript or explanation_has_noise or explanation_mostly_english):
            issues.append("explanation 过长或噪声较多")
            severity += 2

        if severity < 2:
            return None
        return {"issues": issues[:4], "severity": severity}

    def format_review_cleanup_request(self, proposal: dict) -> str:
        lines = [
            "### 清理建议",
            "",
            "这题已经完成。我先把建议修改的前后差异给你看一下，你确认后我再保存。",
        ]
        issues = proposal.get("issues") if isinstance(proposal.get("issues"), list) else []
        if issues:
            lines.extend(["", "**发现的问题**"])
            for item in issues[:4]:
                lines.append(f"- {item}")

        changed_fields = proposal.get("changed_fields") if isinstance(proposal.get("changed_fields"), list) else []
        if "词条" in changed_fields:
            lines.extend(
                [
                    "",
                    "**词条 before**",
                    markdown_quote(str(proposal.get("before_word") or ""), fallback="(空)"),
                    "",
                    "**词条 after**",
                    markdown_quote(str(proposal.get("after_word") or ""), fallback="(空)"),
                    "",
                    "**文件 before**",
                    markdown_quote(str(proposal.get("before_file") or ""), fallback="(空)"),
                    "",
                    "**文件 after**",
                    markdown_quote(str(proposal.get("after_file") or ""), fallback="(空)"),
                ]
            )
        if "例句" in changed_fields:
            lines.extend(
                [
                    "",
                    "**例句 before**",
                    markdown_quote(str(proposal.get("before_example_text") or ""), fallback="(空)"),
                    "",
                    "**例句 after**",
                    markdown_quote(str(proposal.get("after_example_text") or ""), fallback="(空)"),
                ]
            )
        if "explanation" in changed_fields:
            lines.extend(
                [
                    "",
                    "**Explanation before**",
                    markdown_quote(str(proposal.get("before_example_explanation") or ""), fallback="(空)"),
                    "",
                    "**Explanation after**",
                    markdown_quote(str(proposal.get("after_example_explanation") or ""), fallback="(空)"),
                ]
            )

        summary = collapse_ws(str(proposal.get("summary") or ""))
        if summary:
            lines.extend(["", f"_备注：{summary}_"])

        lines.extend(
            [
                "",
                "回复 `y` 才会保存这些修改。",
                "回复 `n` 不保存。",
                "如果你直接继续说别的，我会默认你不同意，并进入下一题。",
            ]
        )
        return "\n".join(lines)

    def generate_review_cleanup_candidate(
        self,
        current: dict,
        *,
        original_text: str,
        original_explanation: str,
        allow_llm: bool = True,
        allow_non_word_changes: bool = True,
        word_hint: str = "",
    ) -> dict:
        cleaned_text = strip_review_noise(original_text) or original_text
        cleaned_explanation = strip_review_noise(original_explanation) or original_explanation
        llm_notes = ""
        llm_word = ""
        source_info = current.get("example_source") if isinstance(current.get("example_source"), dict) else {}
        source_bound = any(collapse_ws(str(value)) for value in source_info.values())
        fallback_word_candidates = cleanup_word_candidates(current, cleaned_text or original_text, cleaned_explanation or original_explanation)

        def is_cleanup_text_trustworthy(candidate_text: str) -> bool:
            proposed = collapse_ws(candidate_text)
            baseline = collapse_ws(cleaned_text or original_text)
            raw_original = collapse_ws(original_text)
            if not proposed:
                return False
            if not looks_mostly_english(proposed):
                return False
            if not source_bound:
                return True
            if proposed.lower() == baseline.lower() or proposed.lower() == raw_original.lower():
                return True
            original_tokens = {
                token.lower()
                for token in re.findall(r"[A-Za-z][A-Za-z'-]{1,}", raw_original)
            }
            proposed_tokens = {
                token.lower()
                for token in re.findall(r"[A-Za-z][A-Za-z'-]{1,}", proposed)
            }
            if not proposed_tokens:
                return False
            return proposed_tokens.issubset(original_tokens)

        def is_cleanup_word_trustworthy(candidate_word: str) -> bool:
            proposed = normalize_word_key(candidate_word)
            original_word = normalize_word_key(str(current.get("word") or current.get("word_key") or ""))
            if not proposed:
                return False
            if proposed == original_word:
                return True
            direct_base_candidates = set(inflection_base_candidates(original_word))
            trusted = set(fallback_word_candidates)
            trusted.update(direct_base_candidates)
            focus_words = current.get("focus_words") if isinstance(current.get("focus_words"), list) else []
            for token in focus_words:
                trusted.update(inflection_base_candidates(str(token)))
            if len(proposed) < len(original_word):
                return proposed in direct_base_candidates
            return proposed in trusted

        if allow_llm and self.llm_client.enabled:
            cleanup_scope = "full" if allow_non_word_changes else "word_only"
            system_prompt = (
                "你是英语词汇卡片清洗助手。"
                "请只返回 JSON，字段必须包含: word, example_text, explanation, notes。"
                "要求: 1) 去掉说话人标记、编号、链接和明显 OCR 噪声；"
                "2) example_text 只允许最小必要清洗，尽量保留原句措辞和结构，不能自由改写；"
                "3) explanation 必须是自然、完整、简洁的中文，并点明目标词在句中的意思；"
                "4) 如果例句绑定了来源，example_text 必须忠实原句，只去噪，不要换词、改写或补充原句没有的信息；"
                "5) 只有在证据非常明确时才改 word，而且只能收敛到屈折变化对应的原型；不允许猜测性补字母；"
                "6) 如果 cleanup_scope 是 word_only，就只判断 word 是否要改，example_text 和 explanation 保持原意，不要顺手改写；"
                "7) 不要输出 markdown，不要编造原句没有的信息。"
            )
            user_prompt = json.dumps(
                {
                    "word": current.get("word", ""),
                    "word_key": current.get("word_key", ""),
                    "definitions": current.get("definitions", []),
                    "focus_words": current.get("focus_words", []),
                    "source": source_info,
                    "cleanup_scope": cleanup_scope,
                    "word_hint": word_hint,
                    "example_text": original_text,
                    "example_explanation": original_explanation,
                },
                ensure_ascii=False,
            )
            result = {}
            for _attempt in range(2):
                try:
                    result = self.llm_client.chat_json(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        max_tokens=420,
                        temperature=0.1,
                        timeout=90.0,
                    )
                except Exception:
                    result = {}
                    continue

                llm_text = collapse_ws(str(result.get("example_text") or result.get("text") or ""))
                llm_explanation = collapse_ws(str(result.get("explanation") or ""))
                candidate_word = normalize_word_key(str(result.get("word") or ""))
                candidate_notes = collapse_ws(str(result.get("notes") or ""))

                accepted = False
                if allow_non_word_changes and llm_text and is_cleanup_text_trustworthy(llm_text):
                    cleaned_text = llm_text
                    accepted = True
                if allow_non_word_changes and llm_explanation and contains_cjk(llm_explanation):
                    cleaned_explanation = llm_explanation
                    accepted = True
                if candidate_word and is_cleanup_word_trustworthy(candidate_word):
                    llm_word = candidate_word
                    accepted = True
                if candidate_notes:
                    llm_notes = candidate_notes
                if accepted:
                    break

        if not cleaned_explanation:
            for item in current.get("definitions", []):
                definition = collapse_ws(str(item))
                if contains_cjk(definition):
                    cleaned_explanation = definition
                    break

        original_word = normalize_word_key(str(current.get("word") or current.get("word_key") or ""))
        cleaned_word = llm_word or original_word

        return {
            "word": cleaned_word,
            "example_text": cleaned_text or original_text,
            "explanation": cleaned_explanation or original_explanation,
            "summary": llm_notes,
        }

    def build_review_cleanup_proposal(self, current: dict) -> dict | None:
        report = self.inspect_review_content_issues(current)

        detail = self.linkualog_client.get_vocab_detail(str(current.get("word_key") or ""), str(current.get("category") or ""))
        payload = detail.get("data") if isinstance(detail.get("data"), dict) else {}
        examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []
        raw_example_index = current.get("example_index", -1)
        try:
            example_index = int(raw_example_index)
        except (TypeError, ValueError):
            example_index = -1
        if example_index < 0 or example_index >= len(examples) or not isinstance(examples[example_index], dict):
            return None

        example = dict(examples[example_index])
        original_text = collapse_ws(str(example.get("text") or ""))
        original_explanation = collapse_ws(str(example.get("explanation") or ""))
        word_hint = guess_cleanup_word_candidate(current, original_text, original_explanation)
        if not report and not (word_hint and self.llm_client.enabled):
            return None

        candidate = self.generate_review_cleanup_candidate(
            current,
            original_text=original_text,
            original_explanation=original_explanation,
            allow_llm=bool(report or word_hint),
            allow_non_word_changes=bool(report),
            word_hint=word_hint,
        )
        original_word = normalize_word_key(str(current.get("word") or current.get("word_key") or ""))
        cleaned_text = collapse_ws(str(candidate.get("example_text") or "")) or original_text
        cleaned_explanation = collapse_ws(str(candidate.get("explanation") or "")) or original_explanation
        cleaned_word = normalize_word_key(str(candidate.get("word") or "")) or original_word
        original_file = normalize_json_filename(str(current.get("file") or ""))
        cleaned_file = normalize_json_filename(f"{cleaned_word}.json") if cleaned_word else original_file

        changed_fields = []
        if cleaned_word != original_word:
            changed_fields.append("词条")
        if cleaned_text != original_text:
            changed_fields.append("例句")
        if cleaned_explanation != original_explanation:
            changed_fields.append("explanation")
        if not changed_fields:
            return None

        issues = list(report.get("issues", [])) if isinstance(report, dict) else []
        if "词条" in changed_fields and "词条名可能不完整或有误" not in issues:
            issues.insert(0, "词条名可能不完整或有误")

        return {
            "word": current.get("word", ""),
            "category": current.get("category", ""),
            "file": original_file,
            "word_key": current.get("word_key", ""),
            "example_index": example_index,
            "issues": issues[:4],
            "changed_fields": changed_fields,
            "before_word": original_word,
            "after_word": cleaned_word,
            "before_file": original_file,
            "after_file": cleaned_file,
            "before_example_text": original_text,
            "after_example_text": cleaned_text,
            "before_example_explanation": original_explanation,
            "after_example_explanation": cleaned_explanation,
            "summary": collapse_ws(str(candidate.get("summary") or "")),
        }

    def blank_target_in_text(self, current: dict, text: str) -> str:
        raw_text = str(text or "").strip()
        if not raw_text:
            return ""
        raw_candidates = [
            str(current.get("word") or "").strip(),
            str(current.get("word_key") or "").replace("-", " ").strip(),
            str(current.get("word_key") or "").strip(),
        ]
        seen: set[str] = set()
        for candidate in sorted(raw_candidates, key=len, reverse=True):
            normalized = normalize_review_surface_text(candidate)
            if not candidate or not normalized or normalized in seen:
                continue
            seen.add(normalized)
            parts = [re.escape(part) for part in re.split(r"[\s-]+", candidate) if part]
            if not parts:
                continue
            pattern = re.compile(
                rf"(?<![A-Za-z0-9]){'[-\\s]+'.join(parts)}(?![A-Za-z0-9])",
                flags=re.IGNORECASE,
            )
            replaced, count = pattern.subn("_____", raw_text, count=1)
            if count:
                return replaced
        return ""

    def build_fill_blank_challenge(self, current: dict) -> dict:
        return review_teaching_mod.build_fill_blank_challenge(current, llm_client=self.llm_client)

    def build_creative_challenge(self, current: dict) -> dict:
        return review_teaching_mod.build_creative_challenge(current, llm_client=self.llm_client)

    def ensure_review_challenge(self, current: dict, mode: int) -> dict:
        return review_teaching_mod.ensure_review_challenge(current, mode, llm_client=self.llm_client)

    def prepare_current_review_prompt(self, session: dict, *, intro: bool, note: str = "") -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_prepare", "review 状态异常，已退出。", status="error")

        current = review.get("current")
        if not isinstance(current, dict):
            return self.prepare_next_review_prompt(session, intro=intro)

        review["pending_cleanup"] = None
        mode = self.get_active_review_mode(session)
        challenge = self.ensure_review_challenge(current, mode)
        prompt = self.format_review_prompt(current, intro=intro, mode=mode, challenge=challenge, note=note)
        return self.reply_md(
            "review_prompt",
            prompt,
            status="success",
            category=current.get("category", ""),
            word=current.get("word", ""),
            mode=mode,
        )

    def format_review_prompt(self, current: dict, *, intro: bool, mode: int, challenge: dict, note: str = "") -> str:
        return review_teaching_mod.format_review_prompt(
            current,
            intro=intro,
            mode=mode,
            challenge=challenge,
            llm_client=self.llm_client,
            note=note,
            mode_command=MODE_COMMAND,
            skip_command=SKIP_COMMAND,
            end_command=END_COMMAND,
        )

    def handle_review_message(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_message", "review 状态异常，已退出。", status="error")

        pending_cleanup = review.get("pending_cleanup")
        if isinstance(pending_cleanup, dict):
            return self.handle_review_cleanup_confirmation(session, normalized_text)

        current = review.get("current")
        if not isinstance(current, dict):
            return self.prepare_next_review_prompt(session)

        if not normalized_text:
            return self.reply_md(
                "review_message",
                f"### 需要作答\n\n请直接回答，或使用 `{SKIP_COMMAND}` / `{END_COMMAND}`。",
                status="error",
            )

        review_mode = self.get_active_review_mode(session)
        grade = self.grade_review_answer(current, normalized_text, review_mode)
        if grade.get("status") == "error":
            return self.reply("review_grade", str(grade.get("message") or "批改失败"), status="error")

        score = int(grade.get("score", 0) or 0)
        try:
            self.linkualog_client.review_suggest(
                category=str(current.get("category") or ""),
                filename=str(current.get("file") or ""),
                score=score,
                auto_save=True,
            )
            self.append_review_session_log(current=current, envelope=envelope, answer=normalized_text, grade=grade)
        except Exception as exc:
            return self.reply("review_grade", f"记录复习结果失败: {exc}", status="error")

        excluded = review.setdefault("excluded_keys", [])
        current_key = str(current.get("key") or "")
        if current_key and current_key not in excluded:
            excluded.append(current_key)

        history = review.setdefault("history", [])
        history.append(
            {
                "graded_at": now_iso(),
                "word": current.get("word", ""),
                "key": current_key,
                "score": score,
                "answer": normalized_text,
                "feedback": grade.get("feedback", ""),
            }
        )
        review["history"] = history[-50:]

        cleanup_proposal = None
        try:
            cleanup_proposal = self.build_review_cleanup_proposal(current)
        except Exception as exc:
            print(f"[review-cleanup] proposal failed: {exc}")

        feedback_text = self.format_review_feedback(current, grade, review_mode)
        if isinstance(cleanup_proposal, dict):
            review["pending_cleanup"] = cleanup_proposal
            return self.reply_md(
                "review_grade",
                feedback_text + "\n\n" + self.format_review_cleanup_request(cleanup_proposal),
                status="pending_cleanup",
                score=score,
                word=current.get("word", ""),
            )

        next_result = self.prepare_next_review_prompt(session, intro=False)
        if next_result.should_reply and next_result.reply_text:
            combined = feedback_text + "\n\n" + next_result.reply_text
        else:
            combined = feedback_text
        return self.reply_md(
            "review_grade",
            combined,
            status="success",
            score=score,
            word=current.get("word", ""),
        )

    def handle_review_cleanup_confirmation(self, session: dict, normalized_text: str) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_cleanup", "review 状态异常，已退出。", status="error")

        lowered = normalized_text.lower()

        if lowered in CLEANUP_APPROVE_WORDS:
            return self.apply_review_cleanup(session)
        review["pending_cleanup"] = None
        note = (
            "### 已跳过清理\n\n- 你没有同意保存这次清理建议。"
            if lowered in NO_WORDS
            else "### 已默认不保存清理\n\n- 未收到明确同意，已按未同意处理。"
        )
        next_result = self.prepare_next_review_prompt(session, intro=False)
        return self.combine_markdown_reply(
            "review_cleanup_skip",
            note,
            next_result,
            status="success",
        )

    def apply_review_cleanup_proposal(self, proposal: dict) -> dict:
        detail = self.linkualog_client.get_vocab_detail(str(proposal.get("word_key") or ""), str(proposal.get("category") or ""))
        payload = detail.get("data") if isinstance(detail.get("data"), dict) else {}
        examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []
        raw_example_index = proposal.get("example_index", -1)
        try:
            example_index = int(raw_example_index)
        except (TypeError, ValueError):
            example_index = -1
        if example_index < 0 or example_index >= len(examples) or not isinstance(examples[example_index], dict):
            raise RuntimeError("当前例句定位失败，未做保存。")

        example = dict(examples[example_index])
        changed_fields = proposal.get("changed_fields") if isinstance(proposal.get("changed_fields"), list) else []
        if "例句" in changed_fields:
            example["text"] = collapse_ws(str(proposal.get("after_example_text") or ""))
        if "explanation" in changed_fields:
            example["explanation"] = collapse_ws(str(proposal.get("after_example_explanation") or ""))

        examples[example_index] = example
        payload["examples"] = examples
        before_word = normalize_word_key(str(proposal.get("before_word") or proposal.get("word") or ""))
        after_word = normalize_word_key(str(proposal.get("after_word") or before_word))
        if "词条" in changed_fields and after_word and after_word != before_word:
            merged_from = payload.get("mergedFrom")
            if not isinstance(merged_from, list):
                merged_from = []
            if before_word and before_word != after_word and before_word not in merged_from:
                merged_from.append(before_word)
            if merged_from:
                payload["mergedFrom"] = merged_from
            saved = self.linkualog_client.rename_vocab(
                category=str(proposal.get("category") or ""),
                filename=str(proposal.get("file") or ""),
                word=after_word,
                data=payload,
            )
        else:
            saved = self.linkualog_client.save_vocab(
                category=str(proposal.get("category") or ""),
                filename=str(proposal.get("file") or ""),
                data=payload,
            )
        saved_payload = saved.get("data") if isinstance(saved.get("data"), dict) else payload
        summary = f"已保存{'、'.join(changed_fields)}。"
        proposal_summary = collapse_ws(str(proposal.get("summary") or ""))
        if proposal_summary:
            summary += f" {proposal_summary}"
        final_file = normalize_json_filename(str(saved.get("file") or saved.get("target_file") or proposal.get("after_file") or proposal.get("file") or ""))
        final_word = collapse_ws(str(saved_payload.get("word") or after_word or proposal.get("after_word") or proposal.get("word") or ""))
        return {
            "data": saved_payload,
            "summary": summary,
            "file": final_file,
            "word": final_word,
        }

    def apply_review_cleanup(self, session: dict) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_cleanup", "review 状态异常，已退出。", status="error")

        proposal = review.get("pending_cleanup")
        if not isinstance(proposal, dict):
            return self.prepare_next_review_prompt(session)

        try:
            saved_result = self.apply_review_cleanup_proposal(proposal)
        except Exception as exc:
            return self.reply_md(
                "review_cleanup",
                (
                    "### 清理保存失败\n\n"
                    f"- 错误: {shorten_text(str(exc), 160)}\n"
                    "- 你可以回复 `y` 重试，或回复别的内容跳过。"
                ),
                status="error",
            )

        summary = collapse_ws(str(saved_result.get("summary") or "已保存清理。"))
        final_file = normalize_json_filename(str(saved_result.get("file") or proposal.get("after_file") or proposal.get("file") or ""))
        final_word = collapse_ws(str(saved_result.get("word") or proposal.get("after_word") or proposal.get("word") or ""))
        if final_file:
            next_key = f"{proposal.get('category', '')}/{final_file}".strip("/")
            excluded = review.setdefault("excluded_keys", [])
            if next_key and next_key not in excluded:
                excluded.append(next_key)
        current = review.get("current")
        if isinstance(current, dict):
            if final_file:
                current["file"] = final_file
                current["word_key"] = os.path.splitext(final_file)[0]
            if final_word:
                current["word"] = final_word
            changed_fields = proposal.get("changed_fields") if isinstance(proposal.get("changed_fields"), list) else []
            if "例句" in changed_fields:
                current["example_text"] = collapse_ws(str(proposal.get("after_example_text") or current.get("example_text") or ""))
            if "explanation" in changed_fields:
                current["example_explanation"] = collapse_ws(str(proposal.get("after_example_explanation") or current.get("example_explanation") or ""))
        review["pending_cleanup"] = None
        next_result = self.prepare_next_review_prompt(session, intro=False)
        word_line = f"**{proposal.get('word', '')}**"
        if "词条" in (proposal.get("changed_fields") if isinstance(proposal.get("changed_fields"), list) else []):
            word_line = f"**{proposal.get('word', '')}** -> **{final_word or proposal.get('after_word', '')}**"
        return self.combine_markdown_reply(
            "review_cleanup",
            (
                "### 已保存清理\n\n"
                f"- 词条: {word_line}\n"
                f"- 结果: {summary}"
            ),
            next_result,
            status="success",
        )

    def skip_review_item(self, session: dict) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_skip", "review 状态异常。", status="error")
        current = review.get("current")
        review["pending_cleanup"] = None
        if isinstance(current, dict):
            key = str(current.get("key") or "")
            if key and key not in review.setdefault("excluded_keys", []):
                review["excluded_keys"].append(key)
        return self.prepare_next_review_prompt(session, intro=False)

    def format_review_feedback(self, current: dict, grade: dict, mode: int) -> str:
        matched = grade.get("matched_points") if isinstance(grade.get("matched_points"), list) else []
        missing = grade.get("missing_points") if isinstance(grade.get("missing_points"), list) else []
        reference = current.get("example_explanation") or (current.get("definitions") or [""])[0]
        memory_hints = review_teaching_mod.infer_review_memory_hints(current, limit=2, llm_client=self.llm_client)
        lines = [
            "### 本题反馈",
            "",
            f"- 评分: `{grade.get('score', 0)}/5`",
            f"- 模式: `模式 {mode} · {review_mode_label(mode)}`",
            (
                f"- 正确答案: **{current.get('word', '')}**"
                if mode == 2
                else f"- 词条: **{current.get('word', '')}**"
            ),
            f"- 评语: {grade.get('feedback', '')}",
        ]
        if reference:
            lines.append(f"- 参考理解: {shorten_text(str(reference), 120)}")
        if matched:
            lines.extend(["", "**答对点**"])
            for item in matched[:3]:
                lines.append(f"- {item}")
        if missing:
            lines.extend(["", "**待补强**"])
            for item in missing[:3]:
                lines.append(f"- {item}")
        if memory_hints:
            lines.extend(["", "**构词联想**"])
            for item in memory_hints:
                lines.append(f"- {item}")
        if current.get("example_text"):
            lines.extend(["", "**原例句**", markdown_quote(str(current.get("example_text") or ""))])
        return "\n".join(lines)

    def grade_review_explanation_answer(self, current: dict, answer: str) -> dict:
        if not self.llm_client.enabled:
            return {"status": "error", "message": "当前未配置可用 LLM，无法自动批改 review。"}

        system_prompt = (
            "你是英语词汇复习批改器。"
            "根据词条、例句、参考释义与用户答案，输出 JSON。"
            "必须返回字段: score(0-5整数), feedback, matched_points(数组), missing_points(数组)。"
            "评分标准: 5=准确完整; 4=大体正确但不够完整; 3=部分正确; 2=理解偏弱; 1=基本错误但有关联; 0=空白或离题。"
            "feedback 用中文，短而明确。不要输出 JSON 以外内容。"
        )
        user_prompt = json.dumps(
            {
                "word": current.get("word", ""),
                "definitions": current.get("definitions", []),
                "example_text": current.get("example_text", ""),
                "example_explanation": current.get("example_explanation", ""),
                "user_answer": answer,
            },
            ensure_ascii=False,
        )
        try:
            result = self.llm_client.chat_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_tokens=500,
                temperature=0.1,
                timeout=90.0,
            )
        except Exception as exc:
            return {"status": "error", "message": f"LLM 批改失败: {exc}"}

        score = result.get("score")
        try:
            final_score = max(0, min(5, int(score)))
        except (TypeError, ValueError):
            final_score = 0
        feedback = collapse_ws(str(result.get("feedback") or "")) or "已完成批改。"
        matched = result.get("matched_points") if isinstance(result.get("matched_points"), list) else []
        missing = result.get("missing_points") if isinstance(result.get("missing_points"), list) else []
        return {
            "status": "success",
            "score": final_score,
            "feedback": feedback,
            "matched_points": [collapse_ws(str(item)) for item in matched if collapse_ws(str(item))],
            "missing_points": [collapse_ws(str(item)) for item in missing if collapse_ws(str(item))],
        }

    def grade_fill_blank_answer(self, current: dict, answer: str) -> dict:
        challenge = self.ensure_review_challenge(current, 2)
        raw_accepted = challenge.get("accepted_answers") if isinstance(challenge.get("accepted_answers"), list) else []
        accepted_keys = {
            normalize_answer_key(str(item))
            for item in raw_accepted + [current.get("word", ""), current.get("word_key", "")]
            if normalize_answer_key(str(item))
        }
        answer_key = normalize_answer_key(answer)
        target = collapse_ws(str(current.get("word") or current.get("word_key") or ""))

        if not answer_key:
            return {
                "status": "success",
                "score": 0,
                "feedback": f"还没有真正作答，正确答案是 {target}。",
                "matched_points": [],
                "missing_points": ["需要直接填英文单词或短语"],
            }

        if answer_key in accepted_keys:
            return {
                "status": "success",
                "score": 5,
                "feedback": "填空正确。",
                "matched_points": [f"准确回忆出目标词 {target}"],
                "missing_points": [],
            }

        if any(key and (answer_key in key or key in answer_key) for key in accepted_keys):
            return {
                "status": "success",
                "score": 4,
                "feedback": f"基本答对了，核心词就是 {target}。",
                "matched_points": ["已经回忆到正确核心词形"],
                "missing_points": ["格式还可以更精确一些"],
            }

        best_ratio = max((SequenceMatcher(None, answer_key, key).ratio() for key in accepted_keys), default=0.0)
        if best_ratio >= 0.84:
            return {
                "status": "success",
                "score": 2,
                "feedback": f"和正确答案 {target} 很接近，像是拼写或形式差了一点。",
                "matched_points": ["已经接近正确答案"],
                "missing_points": [f"正确答案是 {target}"],
            }

        return {
            "status": "success",
            "score": 0,
            "feedback": f"这次没填对，正确答案是 {target}。",
            "matched_points": [],
            "missing_points": [f"需要回忆出目标词 {target}"],
        }

    def grade_creative_answer(self, current: dict, answer: str) -> dict:
        target_key = normalize_answer_key(str(current.get("word") or current.get("word_key") or ""))
        answer_key = normalize_answer_key(answer)
        if not answer_key:
            return {
                "status": "success",
                "score": 0,
                "feedback": "答案为空，至少先写一句英文。",
                "matched_points": [],
                "missing_points": ["需要给出完整英文句子"],
            }

        if target_key and target_key not in answer_key:
            return {
                "status": "success",
                "score": 1,
                "feedback": f"你已经开始造句了，但句子里还没有真正用到目标词 {current.get('word', '')}。",
                "matched_points": [],
                "missing_points": [f"必须实际用上 {current.get('word', '')}"],
            }

        if not self.llm_client.enabled:
            return {
                "status": "success",
                "score": 3,
                "feedback": "检测到你已经用上目标词了；若想精细批改自然度和准确性，需要配置 LLM。",
                "matched_points": ["已经实际使用了目标词"],
                "missing_points": ["尚未检查语法和自然度细节"],
            }

        challenge = self.ensure_review_challenge(current, 3)
        system_prompt = (
            "你是英语词汇复习批改器，负责模式3创意输出。"
            "根据目标词、例句、参考释义、任务要求和用户答案，输出 JSON。"
            "必须返回字段: score(0-5整数), feedback, matched_points(数组), missing_points(数组)。"
            "评分重点: 是否真正用到目标词、是否完成题目要求、语义是否正确、句子是否自然。"
            "如果只是生硬塞词、没有贴合给定微场景，最高不超过 3 分。"
            "如果明显照抄参考例句或场景很空，要扣分。"
            "feedback 用中文，短而明确。不要输出 JSON 以外内容。"
        )
        user_prompt = json.dumps(
            {
                "word": current.get("word", ""),
                "definitions": current.get("definitions", []),
                "example_text": current.get("example_text", ""),
                "example_explanation": current.get("example_explanation", ""),
                "challenge": challenge,
                "user_answer": answer,
            },
            ensure_ascii=False,
        )
        try:
            result = self.llm_client.chat_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_tokens=500,
                temperature=0.1,
                timeout=90.0,
            )
        except Exception as exc:
            return {"status": "error", "message": f"LLM 批改失败: {exc}"}

        score = result.get("score")
        try:
            final_score = max(0, min(5, int(score)))
        except (TypeError, ValueError):
            final_score = 0
        feedback = collapse_ws(str(result.get("feedback") or "")) or "已完成批改。"
        matched = result.get("matched_points") if isinstance(result.get("matched_points"), list) else []
        missing = result.get("missing_points") if isinstance(result.get("missing_points"), list) else []
        return {
            "status": "success",
            "score": final_score,
            "feedback": feedback,
            "matched_points": [collapse_ws(str(item)) for item in matched if collapse_ws(str(item))],
            "missing_points": [collapse_ws(str(item)) for item in missing if collapse_ws(str(item))],
        }

    def grade_review_answer(self, current: dict, answer: str, mode: int) -> dict:
        if mode == 2:
            return self.grade_fill_blank_answer(current, answer)
        if mode == 3:
            return self.grade_creative_answer(current, answer)
        return self.grade_review_explanation_answer(current, answer)

    def append_review_session_log(self, *, current: dict, envelope: dict, answer: str, grade: dict) -> None:
        detail = self.linkualog_client.get_vocab_detail(str(current.get("word_key") or ""), str(current.get("category") or ""))
        payload = detail.get("data") if isinstance(detail.get("data"), dict) else {}
        review_sessions = payload.get("reviewSessions")
        if not isinstance(review_sessions, list):
            review_sessions = []

        review_sessions.append(
            {
                "timestamp": now_iso(),
                "platform": "qq",
                "conversation_id": envelope.get("conversation_id"),
                "sender_id": envelope.get("sender_id"),
                "word": current.get("word", ""),
                "example_text": current.get("example_text", ""),
                "expected_definitions": current.get("definitions", []),
                "review_mode": int(current.get("challenge", {}).get("mode", 1) or 1),
                "user_answer": answer,
                "score": int(grade.get("score", 0) or 0),
                "feedback": grade.get("feedback", ""),
                "matched_points": grade.get("matched_points", []),
                "missing_points": grade.get("missing_points", []),
            }
        )
        payload["reviewSessions"] = review_sessions[-50:]
        self.linkualog_client.save_vocab(
            category=str(current.get("category") or ""),
            filename=str(current.get("file") or ""),
            data=payload,
        )

    def handle_idle_message(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        attachments = self.extract_attachment_candidates(envelope)
        if attachments:
            return self.reply(
                "idle_attachment",
                f"当前不在 [upload] 模式。若要往 linkualog 收集文件，请先发 {UPLOAD_COMMAND}。",
                status="error",
            )

        lowered = normalized_text.lower()
        if lowered in GREETING_WORDS:
            return self.reply(
                "greeting",
                f"你好，我是 Linkualog QQ Bot。\n\n发 `{HELP_COMMAND}` 可以查看我能做什么。",
                status="success",
                message_format="markdown",
            )

        if DIRECT_WORD_PATTERN.fullmatch(lowered):
            return self.search_vocab(normalized_text, str(session.get("current_category") or "daily"))

        plan = self.plan_idle_with_llm(session, normalized_text)
        if plan:
            return self.execute_idle_plan(session, envelope, normalized_text, plan)

        return self.save_inbox(envelope, normalized_text)

    def plan_idle_with_llm(self, session: dict, normalized_text: str) -> dict | None:
        if not self.llm_client.enabled or not normalized_text:
            return None

        system_prompt = (
            "你是 QQ 到 linkualog 的路由器。"
            "根据用户自然语言，选择一个最合适的固定工具。"
            "工具列表: "
            "search_vocab(query), set_category(category), start_add_mode(), start_upload_mode(task_name), "
            "start_review_mode(category), add_vocab_once(word, context, source), save_inbox(). "
            "规则: 只在高把握时输出具体工具；否则输出 save_inbox。"
            "返回 JSON: {tool, confidence, requires_confirmation, summary, args}。"
            "requires_confirmation 默认 false。不要输出 JSON 以外内容。"
        )
        user_prompt = json.dumps(
            {
                "current_category": session.get("current_category", "daily"),
                "text": normalized_text,
            },
            ensure_ascii=False,
        )
        try:
            plan = self.llm_client.chat_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_tokens=400,
                temperature=0.1,
                timeout=60.0,
            )
        except Exception as exc:
            print(f"[llm-route] failed: {exc}")
            return None

        tool = collapse_ws(str(plan.get("tool") or "")).lower()
        if not tool:
            return None
        try:
            confidence = float(plan.get("confidence", 0.0) or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0
        plan["confidence"] = confidence
        if confidence < self.route_confidence_threshold and tool != "save_inbox":
            return None
        if not isinstance(plan.get("args"), dict):
            plan["args"] = {}
        return plan

    def execute_idle_plan(self, session: dict, envelope: dict, normalized_text: str, plan: dict) -> ToolResult:
        tool = str(plan.get("tool") or "").lower()
        args = plan.get("args") if isinstance(plan.get("args"), dict) else {}
        requires_confirmation = bool(plan.get("requires_confirmation", False))
        summary = collapse_ws(str(plan.get("summary") or tool))

        if requires_confirmation:
            session["pending_confirmation"] = {"summary": summary, "plan": plan}
            return self.reply(
                "confirm_request",
                f"即将执行敏感动作: {summary}\n回复 y/1 确认，回复 n/0 取消。",
                status="pending_confirmation",
            )

        if tool == "search_vocab":
            return self.search_vocab(str(args.get("query") or normalized_text), str(session.get("current_category") or "daily"))
        if tool == "set_category":
            return self.change_category(session, str(args.get("category") or ""))
        if tool == "start_add_mode":
            return self.start_add_mode(session)
        if tool == "start_upload_mode":
            return self.start_upload_mode(session, str(args.get("task_name") or ""))
        if tool == "start_review_mode":
            return self.start_review_mode(session, str(args.get("category") or ""))
        if tool == "add_vocab_once":
            parsed = {
                "word": normalize_word_key(str(args.get("word") or "")),
                "context": collapse_ws(str(args.get("context") or "")),
                "source": collapse_ws(str(args.get("source") or "")) or "QQ natural route",
            }
            if not parsed["word"]:
                return self.save_inbox(envelope, normalized_text)
            return self.add_vocab_entry(session, parsed, source_fallback="QQ natural route")
        return self.save_inbox(envelope, normalized_text)

    def save_inbox(self, envelope: dict, normalized_text: str) -> ToolResult:
        record_id = self.build_record_id(envelope, normalized_text)
        path = self.local_data_dir / "inbox" / f"{today_iso()}.jsonl"
        append_jsonl(
            path,
            {
                "record_id": record_id,
                "received_at": envelope.get("received_at"),
                "scene": envelope.get("scene"),
                "event_type": envelope.get("event_type"),
                "message_id": envelope.get("message_id"),
                "sender_id": envelope.get("sender_id"),
                "conversation_id": envelope.get("conversation_id"),
                "text": normalized_text,
                "attachments_count": len(envelope.get("attachments") or []),
            },
        )
        return self.reply(
            "save_inbox",
            f"我还没把这句话匹配到明确操作，已先保存为普通消息记录。\n\n编号: `{record_id}`\n\n发 `{HELP_COMMAND}` 可查看命令。",
            status="success",
            record_id=record_id,
            path=str(path),
            message_format="markdown",
        )

    def build_record_id(self, envelope: dict, normalized_text: str) -> str:
        raw = "|".join(
            [
                str(envelope.get("message_id") or ""),
                str(envelope.get("connector_event_id") or ""),
                str(envelope.get("sender_id") or ""),
                normalized_text,
                str(time.time_ns()),
            ]
        )
        suffix = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
        return f"qq-{today_iso()}-{suffix}"


class GatewayClient:
    def __init__(
        self,
        *,
        token_manager: TokenManager,
        gateway_url: str,
        intents: int,
        shard_id: int,
        shard_count: int,
        run_seconds: int,
        app: QQLinkuaLogApp,
    ) -> None:
        self.token_manager = token_manager
        self.gateway_url = gateway_url
        self.intents = intents
        self.shard_id = shard_id
        self.shard_count = shard_count
        self.run_seconds = run_seconds
        self.app = app
        self.last_sequence: int | None = None
        self.session_id: str | None = None
        self.heartbeat_interval_ms: int | None = None
        self.websocket: websockets.ClientConnection | None = None
        self.ready_event = asyncio.Event()
        self.stop_event = asyncio.Event()
        self.replied_message_ids = DedupCache()

    async def run(self) -> None:
        print(f"[gateway] connecting to {self.gateway_url}")
        async with websockets.connect(self.gateway_url, ping_interval=None, max_size=8 * 1024 * 1024) as ws:
            self.websocket = ws
            reader_task = asyncio.create_task(self.reader_loop(), name="reader_loop")
            timeout_task = asyncio.create_task(self.timeout_loop(), name="timeout_loop")
            try:
                await self.stop_event.wait()
            finally:
                reader_task.cancel()
                timeout_task.cancel()
                await asyncio.gather(reader_task, timeout_task, return_exceptions=True)

    async def timeout_loop(self) -> None:
        if self.run_seconds <= 0:
            return
        await asyncio.sleep(self.run_seconds)
        print(f"[gateway] reached QQ_RUN_SECONDS={self.run_seconds}, stopping client")
        self.stop_event.set()

    async def reader_loop(self) -> None:
        assert self.websocket is not None
        try:
            async for message in self.websocket:
                payload = json.loads(message)
                await self.handle_payload(payload)
        finally:
            self.stop_event.set()

    async def handle_payload(self, payload: dict) -> None:
        op = payload.get("op")
        seq = payload.get("s")
        event_type = payload.get("t")
        data = payload.get("d")

        if isinstance(seq, int):
            self.last_sequence = seq

        print(f"[gateway] op={op} event={event_type!r} seq={seq}")

        if op == 10:
            interval = int((data or {}).get("heartbeat_interval", 0) or 0)
            if interval <= 0:
                raise RuntimeError(f"invalid heartbeat interval in hello payload: {payload}")
            self.heartbeat_interval_ms = interval
            print(f"[gateway] hello received, heartbeat_interval_ms={interval}")
            await self.send_identify()
            asyncio.create_task(self.heartbeat_loop(), name="heartbeat_loop")
            return

        if op == 11:
            print("[gateway] heartbeat ack")
            return

        if op == 7:
            print("[gateway] server requested reconnect")
            self.stop_event.set()
            return

        if op == 9:
            raise RuntimeError(f"invalid session from gateway: {payload}")

        if op == 0 and event_type == "READY":
            self.session_id = (data or {}).get("session_id")
            user = (data or {}).get("user") or {}
            print(
                "[gateway] READY:"
                f" session_id={self.session_id}"
                f" bot_id={user.get('id')}"
                f" username={user.get('username')}"
            )
            self.ready_event.set()
            return

        if op == 0 and event_type == "RESUMED":
            print("[gateway] RESUMED")
            return

        if op == 0:
            await self.handle_dispatch_event(payload)
            return

    async def handle_dispatch_event(self, payload: dict) -> None:
        envelope = normalize_event(payload)
        if envelope is not None:
            print("[event] normalized envelope:")
            print(json.dumps(envelope, ensure_ascii=False, indent=2))

        event_type = payload.get("t")
        if event_type not in WS_EVENT_TYPES_REQUIRING_REPLY:
            return

        data = payload.get("d") or {}
        message_id = str(data.get("id") or "").strip()
        if not message_id:
            print(f"[reply] skip {event_type}: missing message id")
            return

        if envelope is None:
            print(f"[reply] skip {event_type}: failed to normalize envelope")
            return

        if not self.replied_message_ids.add(message_id):
            print(f"[reply] skip duplicate message_id={message_id}")
            return

        result = self.app.handle_envelope(envelope)
        print(
            f"[router] tool={result.tool_name}"
            f" status={(result.metadata or {}).get('status')}"
            f" should_reply={result.should_reply}"
            f" reply={result.reply_text!r}"
        )

        if not result.should_reply or not result.reply_text:
            return

        try:
            if event_type == "C2C_MESSAGE_CREATE":
                await self.reply_c2c_message(data, result)
                return

            if event_type == "GROUP_AT_MESSAGE_CREATE":
                await self.reply_group_message(data, result)
                return
        except Exception as exc:
            print(f"[reply] failed for event_type={event_type} message_id={message_id}: {exc}")

    def build_reply_payload(self, result: ToolResult, msg_id: str, *, force_text: bool = False) -> dict:
        message_format = str((result.metadata or {}).get("message_format") or "text").lower()
        if message_format == "markdown" and not force_text:
            return {
                "markdown": {"content": result.reply_text},
                "msg_type": 2,
                "msg_id": msg_id,
                "msg_seq": 1,
            }
        return {
            "content": result.reply_text,
            "msg_type": 0,
            "msg_id": msg_id,
            "msg_seq": 1,
        }

    async def post_reply_with_fallback(self, path: str, result: ToolResult, msg_id: str) -> dict:
        payload = self.build_reply_payload(result, msg_id)
        try:
            return await asyncio.to_thread(self.post_openapi, path, payload)
        except Exception:
            message_format = str((result.metadata or {}).get("message_format") or "text").lower()
            if message_format != "markdown":
                raise
            fallback_payload = self.build_reply_payload(result, msg_id, force_text=True)
            print("[reply] markdown failed; retrying as text")
            return await asyncio.to_thread(self.post_openapi, path, fallback_payload)

    async def reply_c2c_message(self, data: dict, result: ToolResult) -> None:
        author = data.get("author") or {}
        openid = str(author.get("user_openid") or "").strip()
        msg_id = str(data.get("id") or "").strip()
        if not openid or not msg_id:
            print("[reply] skip c2c reply: missing openid or msg_id")
            return

        path = f"/v2/users/{urllib.parse.quote(openid, safe='')}/messages"
        response = await self.post_reply_with_fallback(path, result, msg_id)
        print(f"[reply] c2c sent: {json.dumps(response, ensure_ascii=False)}")

    async def reply_group_message(self, data: dict, result: ToolResult) -> None:
        group_openid = str(data.get("group_openid") or "").strip()
        msg_id = str(data.get("id") or "").strip()
        if not group_openid or not msg_id:
            print("[reply] skip group reply: missing group_openid or msg_id")
            return

        path = f"/v2/groups/{urllib.parse.quote(group_openid, safe='')}/messages"
        response = await self.post_reply_with_fallback(path, result, msg_id)
        print(f"[reply] group sent: {json.dumps(response, ensure_ascii=False)}")

    def post_openapi(self, path: str, payload: dict) -> dict:
        return openapi_post(self.token_manager.get(), path, payload)

    async def send_identify(self) -> None:
        assert self.websocket is not None
        identify_payload = {
            "op": 2,
            "d": {
                "token": f"QQBot {self.token_manager.get()}",
                "intents": self.intents,
                "shard": [self.shard_id, self.shard_count],
                "properties": {
                    "$os": platform.system().lower(),
                    "$browser": APP_SLUG,
                    "$device": APP_SLUG,
                },
            },
        }
        await self.websocket.send(json.dumps(identify_payload))
        print(
            "[gateway] identify sent:"
            f" intents={self.intents}"
            f" shard=[{self.shard_id}, {self.shard_count}]"
        )

    async def heartbeat_loop(self) -> None:
        assert self.websocket is not None
        assert self.heartbeat_interval_ms is not None
        interval_seconds = self.heartbeat_interval_ms / 1000.0
        while not self.stop_event.is_set():
            await asyncio.sleep(interval_seconds)
            heartbeat_payload = {"op": 1, "d": self.last_sequence}
            await self.websocket.send(json.dumps(heartbeat_payload))
            print(f"[gateway] heartbeat sent seq={self.last_sequence}")


async def async_main() -> int:
    load_local_env()

    app_id = require_env("QQ_APP_ID")
    app_secret = require_env("QQ_APP_SECRET")
    intents = env_int("QQ_INTENTS", C2C_AND_GROUP_INTENTS)
    shard_id = env_int("QQ_SHARD_ID", 0)
    shard_count = env_int("QQ_SHARD_COUNT", 1)
    run_seconds = env_int("QQ_RUN_SECONDS", 90)
    linkualog_data_dir = env_path("QQ_LINKUALOG_DATA_DIR", Path(DEFAULT_LINKUALOG_DATA_DIR))
    local_data_dir = env_path("QQ_LOCAL_DATA_DIR", Path(__file__).with_name("local_data"))
    linkualog_base_url = os.environ.get("QQ_LINKUALOG_BASE_URL", DEFAULT_LINKUALOG_BASE_URL).strip() or DEFAULT_LINKUALOG_BASE_URL
    session_state_file = env_path("QQ_SESSION_STATE_FILE", local_data_dir / "session_state.json")
    llm_enabled = env_bool("QQ_LLM_ROUTE_ENABLED", True)
    llm_provider = (
        os.environ.get("QQ_LLM_PROVIDER", "").strip()
        or os.environ.get("MASTER_SERVER_LLM_PROVIDER", "").strip()
    )
    llm_model = (
        os.environ.get("QQ_LLM_MODEL", "").strip()
        or os.environ.get("MASTER_SERVER_LLM_MODEL", "").strip()
    )
    llm_api_key = (
        os.environ.get("QQ_LLM_API_KEY", "").strip()
        or os.environ.get("MASTER_SERVER_LLM_API_KEY", "").strip()
    )
    add_fetch_llm = env_bool("QQ_ADD_FETCH_LLM", False)
    route_confidence_threshold = env_float("QQ_LLM_ROUTE_CONFIDENCE", 0.72)

    local_data_dir.mkdir(parents=True, exist_ok=True)
    if session_state_file.parent != local_data_dir:
        session_state_file.parent.mkdir(parents=True, exist_ok=True)

    llm_client = LLMClient(
        provider=llm_provider,
        model=llm_model,
        api_key=llm_api_key,
        enabled=llm_enabled,
    )
    linkualog_client = LinkuaLogClient(linkualog_base_url)
    app = QQLinkuaLogApp(
        session_state_file=session_state_file,
        local_data_dir=local_data_dir,
        linkualog_data_dir=linkualog_data_dir,
        linkualog_client=linkualog_client,
        llm_client=llm_client,
        add_fetch_llm=add_fetch_llm,
        route_confidence_threshold=route_confidence_threshold,
    )

    print(f"[router] linkualog_base_url={linkualog_base_url}")
    print(f"[router] linkualog_data_dir={linkualog_data_dir}")
    print(f"[router] local_data_dir={local_data_dir}")
    print(f"[router] session_state_file={session_state_file}")
    print(f"[router] llm_enabled={llm_client.enabled}")

    try:
        health = linkualog_client.health()
        print(f"[linkualog] health={health}")
    except Exception as exc:
        print(f"[linkualog] health check failed: {exc}")

    token_manager = TokenManager(app_id, app_secret)
    print(f"[token] requesting access token for app_id={app_id}")
    access_token = token_manager.get()

    gateway_info = get_gateway(access_token)
    gateway_url = str(gateway_info.get("url", "")).strip()
    recommended_shards = int(gateway_info.get("shards", 0) or 0)
    session_limit = gateway_info.get("session_start_limit") or {}
    if not gateway_url:
        raise RuntimeError(f"gateway url missing in response: {gateway_info}")

    print(
        "[gateway] gateway info:"
        f" url={gateway_url}"
        f" recommended_shards={recommended_shards}"
        f" remaining={session_limit.get('remaining')}"
        f" max_concurrency={session_limit.get('max_concurrency')}"
    )

    if shard_id < 0 or shard_count <= 0 or shard_id >= shard_count:
        raise RuntimeError(f"invalid shard config: shard_id={shard_id}, shard_count={shard_count}")

    client = GatewayClient(
        token_manager=token_manager,
        gateway_url=gateway_url,
        intents=intents,
        shard_id=shard_id,
        shard_count=shard_count,
        run_seconds=run_seconds,
        app=app,
    )
    await client.run()
    return 0


def main() -> int:
    try:
        return asyncio.run(async_main())
    except KeyboardInterrupt:
        print("[main] interrupted")
        return 130
    except Exception as exc:
        print(f"[main] error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
