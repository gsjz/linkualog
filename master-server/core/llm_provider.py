from __future__ import annotations

from urllib.parse import urlparse, urlunparse


CHAT_COMPLETIONS_SUFFIX = "/chat/completions"


def resolve_chat_completions_url(provider: str) -> str:
    raw = str(provider or "").strip()
    if not raw:
        raise ValueError("LLM provider 未配置")

    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("LLM provider 地址不合法")

    path = parsed.path.rstrip("/")
    if path.lower().endswith(CHAT_COMPLETIONS_SUFFIX):
        normalized_path = path
    elif path:
        normalized_path = f"{path}{CHAT_COMPLETIONS_SUFFIX}"
    else:
        normalized_path = CHAT_COMPLETIONS_SUFFIX

    return urlunparse(parsed._replace(path=normalized_path, fragment=""))
