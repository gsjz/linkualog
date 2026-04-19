from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from datetime import datetime
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

import websockets


TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
GATEWAY_URL = "https://api.sgroup.qq.com/gateway/bot"
OPENAPI_BASE_URL = "https://api.sgroup.qq.com"
C2C_AND_GROUP_INTENTS = 1 << 25
APP_DIR = Path(__file__).resolve().parent
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
ON_WORDS = {"1", "on", "true", "yes", "y", "enable", "enabled", "open", "开启", "打开", "开", "自动", "是"}
OFF_WORDS = {"0", "off", "false", "no", "n", "disable", "disabled", "close", "关闭", "关", "手动", "否"}
GREETING_WORDS = {"你好", "您好", "hi", "hello", "hey", "嗨", "哈喽", "在吗", "在么"}
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
    f"- `{SKIP_COMMAND}` 复习时跳过当前词\n"
    f"- `{END_COMMAND}` 结束当前模式\n\n"
    "**上传 OCR 流程**\n\n"
    f"`{UPLOAD_COMMAND}` -> 发送图片/PDF -> `{END_COMMAND}` -> `{PROCESS_COMMAND}` -> `{TASK_COMMAND}`\n\n"
    "**说明**\n\n"
    "- 直接发送英文单词会自动查词。\n"
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
    load_env_file(APP_DIR / ".env.local")
    env_file = os.environ.get("QQ_LINKUALOG_ENV_FILE", "").strip() or DEFAULT_LINKUALOG_ENV_FILE
    if env_file:
        load_env_file(Path(env_file).expanduser())


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


def strip_json_fence(text: str) -> str:
    body = str(text or "").strip()
    if body.startswith("```"):
        body = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", body)
        body = re.sub(r"\s*```$", "", body)
    return body.strip()


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
        payload.setdefault("upload", None)
        payload.setdefault("review", None)
        payload.setdefault("add", None)
        payload.setdefault("last_task_id", "")
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

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        result = http_json(
            "POST",
            self.provider,
            headers={"Authorization": f"Bearer {self.api_key}"},
            data=payload,
            timeout=timeout,
        )
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

    def silent(self, tool_name: str, **metadata: object) -> ToolResult:
        return ToolResult(tool_name=tool_name, reply_text="", metadata=metadata, should_reply=False)

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
            return self.reply("status", self.build_status_text(session), status="success")

        if command == CATEGORIES_COMMAND:
            return self.reply("categories", self.build_categories_text(), status="success")

        if command == CD_COMMAND:
            return self.change_category(session, argument)

        if command == SEARCH_COMMAND:
            return self.search_vocab(argument, session.get("current_category", "daily"))

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
        lines = [f"当前目录: {current_category}", f"当前模式: [{mode}]"]

        upload = session.get("upload") if isinstance(session.get("upload"), dict) else None
        if upload:
            task_name = collapse_ws(str(upload.get("task_name") or "未命名任务"))
            auto_process = bool(upload.get("auto_process", True))
            lines.append(
                "upload 收集: "
                f"{task_name}, "
                f"{len(upload.get('files', []))} 个文件, "
                f"{len(upload.get('notes', []))} 条文本备注, "
                f"自动分析={'开' if auto_process else '关'}"
            )

        review = session.get("review") if isinstance(session.get("review"), dict) else None
        if review:
            current = review.get("current") if isinstance(review.get("current"), dict) else None
            if current:
                lines.append(
                    "review 当前题: "
                    f"{current.get('word', '')} [{current.get('category', '')}]"
                )
            lines.append(f"review 已排除: {len(review.get('excluded_keys', []))}")

        last_task_id = str(session.get("last_task_id") or "").strip()
        if last_task_id:
            lines.append(f"最近任务: {last_task_id}")

        pending = session.get("pending_confirmation")
        if isinstance(pending, dict) and pending:
            lines.append(f"待确认动作: {pending.get('summary', 'unknown')}")
        return "\n".join(lines)

    def build_categories_text(self) -> str:
        categories = self.safe_list_categories()
        if not categories:
            return "当前没有可用目录。"
        preview = ", ".join(categories[:20])
        if len(categories) > 20:
            preview += f" ... 共 {len(categories)} 个"
        return f"可用目录: {preview}"

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
            return self.reply(
                "search_vocab",
                f"linkualog 里暂时没找到 `{query}`。可用 {ADD_COMMAND} 进入添加模式。",
                status="not_found",
                query=query,
            )

        lines = [f"找到 {len(matches)} 个候选词条:"]
        for item in matches:
            definition = shorten_text(item["definition_preview"], 56) if item["definition_preview"] else "暂无释义"
            lines.append(
                f"{item['word']} [{item['category']}] "
                f"defs={item['definition_count']} ex={item['example_count']} marked={item['marked']} "
                f"{definition}"
            )
        return self.reply("search_vocab", "\n".join(lines), status="success", query=query, match_count=len(matches))

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
        return self.reply(
            "task_status",
            (
                f"任务 {task_id}\n"
                f"名称: {result.get('name', '未命名任务')}\n"
                f"状态: {status}\n"
                f"页数: {completed}/{total}\n"
                f"起始页: {start_page}\n"
                f"自动分析: {'是' if auto_process else '否'}"
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
        return self.reply(
            "process_task",
            f"已请求开始处理任务 {task_id}，可稍后用 {TASK_COMMAND} {task_id} 查看进度。",
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
        return self.reply(
            "start_upload",
            (
                f"已进入 [upload] 模式，任务名: {task_name}\n"
                "上传结束后会自动开始分析。\n"
                f"可用 {NAME_COMMAND} 任务名 修改名称，用 {AUTO_COMMAND} off 改为只收集不分析。\n"
                f"现在开始发图片/PDF/文件即可。期间我会静默收集，发 {END_COMMAND} 结束。"
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
        return self.reply(
            "upload_finalize",
            (
                f"已收集 {len(file_items)} 个文件，共 {total} 页内容。\n"
                f"任务名: {task_name}\n"
                f"已创建 linkualog 任务: {task_id}\n"
                + (
                    f"已自动开始分析，可发 {TASK_COMMAND} {task_id} 查看进度。"
                    if auto_process
                    else f"当前不会自动分析。需要处理时可发 {PROCESS_COMMAND} {task_id}"
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
        return self.reply(
            "start_add",
            (
                f"已进入 [add] 模式，当前目录: {category}\n"
                f"直接发送 `word` 或 `word | 例句 | 来源`。发 {END_COMMAND} 退出。"
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
        return self.reply(
            "add_vocab",
            f"已写入 {word} -> {category}，当前 defs={definition_count} ex={example_count}",
            status="success",
            word=word,
            category=category,
            definition_count=definition_count,
            example_count=example_count,
        )

    def start_review_mode(self, session: dict, raw_argument: str) -> ToolResult:
        scope = collapse_ws(raw_argument)
        current_category = str(session.get("current_category") or "daily")
        review_state = {
            "started_at": now_iso(),
            "excluded_keys": [],
            "history": [],
            "current": None,
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
        prompt = self.format_review_prompt(current, intro=intro)
        return self.reply("review_prompt", prompt, status="success", category=category_name, word=current["word"])

    def build_review_item(self, item: dict, data: dict) -> dict:
        examples = data.get("examples") if isinstance(data.get("examples"), list) else []
        chosen_example = {}
        for example in examples:
            if isinstance(example, dict) and collapse_ws(example.get("text", "")):
                chosen_example = example
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
            "definitions": data.get("definitions") if isinstance(data.get("definitions"), list) else [],
            "example_text": collapse_ws(str(chosen_example.get("text") or "")),
            "example_explanation": collapse_ws(str(chosen_example.get("explanation") or "")),
            "reason": collapse_ws(str(item.get("reason") or "")),
            "advice": item.get("advice") if isinstance(item.get("advice"), dict) else {},
        }

    def format_review_prompt(self, current: dict, intro: bool) -> str:
        prefix = "已进入 [review] 模式。\n" if intro else "下一题:\n"
        example_text = current.get("example_text") or "暂无例句"
        reason = current.get("reason") or ""
        lines = [
            prefix.rstrip(),
            f"词: {current.get('word', '')}",
            f"例句: {example_text}",
        ]
        if reason:
            lines.append(f"推荐原因: {reason}")
        lines.append(f"请解释这个词在例句里的意思和用法。可用 {SKIP_COMMAND} 跳过，{END_COMMAND} 退出。")
        return "\n".join(lines)

    def handle_review_message(self, envelope: dict, session: dict, normalized_text: str) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_message", "review 状态异常，已退出。", status="error")

        current = review.get("current")
        if not isinstance(current, dict):
            return self.prepare_next_review_prompt(session)

        if not normalized_text:
            return self.reply("review_message", f"请直接回答，或使用 {SKIP_COMMAND} {END_COMMAND}。", status="error")

        grade = self.grade_review_answer(current, normalized_text)
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

        next_result = self.prepare_next_review_prompt(session, intro=False)
        feedback_text = self.format_review_feedback(current, grade)
        if next_result.should_reply and next_result.reply_text:
            combined = feedback_text + "\n\n" + next_result.reply_text
        else:
            combined = feedback_text
        return self.reply(
            "review_grade",
            combined,
            status="success",
            score=score,
            word=current.get("word", ""),
        )

    def skip_review_item(self, session: dict) -> ToolResult:
        review = session.get("review")
        if not isinstance(review, dict):
            session["mode"] = "idle"
            return self.reply("review_skip", "review 状态异常。", status="error")
        current = review.get("current")
        if isinstance(current, dict):
            key = str(current.get("key") or "")
            if key and key not in review.setdefault("excluded_keys", []):
                review["excluded_keys"].append(key)
        return self.prepare_next_review_prompt(session, intro=False)

    def format_review_feedback(self, current: dict, grade: dict) -> str:
        matched = grade.get("matched_points") if isinstance(grade.get("matched_points"), list) else []
        missing = grade.get("missing_points") if isinstance(grade.get("missing_points"), list) else []
        lines = [
            f"评分: {grade.get('score', 0)}/5",
            f"词: {current.get('word', '')}",
            f"评语: {grade.get('feedback', '')}",
        ]
        if matched:
            lines.append("答对点: " + "；".join(str(item) for item in matched[:3]))
        if missing:
            lines.append("遗漏点: " + "；".join(str(item) for item in missing[:3]))
        return "\n".join(lines)

    def grade_review_answer(self, current: dict, answer: str) -> dict:
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
