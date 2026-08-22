from __future__ import annotations

import json
import socket
import time
from contextlib import closing
from urllib.parse import urlparse

import requests

from core.config import get_config_data
from core.llm_provider import resolve_chat_completions_url


MINIMAL_TEST_PROMPT = (
    'Return exactly this JSON object and nothing else: {"ok":true}'
)


def _clip_text(value, limit: int = 500) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...(truncated,total={len(text)})"


def _coerce_positive_float(value, fallback: float) -> float:
    try:
        parsed = float(value)
        if parsed > 0:
            return parsed
    except (TypeError, ValueError):
        pass
    return fallback


def _extract_message_content(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in {"text", "output_text"}:
                parts.append(str(item.get("text") or ""))
        return "".join(parts).strip()
    return str(content or "").strip()


def _parse_json_reply(text: str):
    clean = str(text or "").replace("```json", "").replace("```", "").strip()
    if not clean:
        raise ValueError("响应内容为空")
    try:
        return json.loads(clean)
    except json.JSONDecodeError as exc:
        parse_error = exc

    starts = [idx for idx in (clean.find("{"), clean.find("[")) if idx >= 0]
    if not starts:
        raise parse_error
    start = min(starts)
    end = max(clean.rfind("}"), clean.rfind("]"))
    if end <= start:
        raise parse_error
    return json.loads(clean[start : end + 1])


def _merge_draft_config(draft: dict | None = None) -> dict:
    config = get_config_data()
    draft = draft if isinstance(draft, dict) else {}

    provider = str(draft.get("provider") or "").strip()
    if provider:
        config["provider"] = provider

    model = str(draft.get("model") or "").strip()
    if model:
        config["model"] = model

    api_key = str(draft.get("api_key") or "").strip()
    if api_key:
        config["api_key"] = api_key

    if "review_llm_timeout_seconds" in draft:
        config["review_llm_timeout_seconds"] = _coerce_positive_float(
            draft.get("review_llm_timeout_seconds"),
            float(config.get("review_llm_timeout_seconds", 75.0)),
        )

    if "review_llm_connectivity_timeout_seconds" in draft:
        config["review_llm_connectivity_timeout_seconds"] = _coerce_positive_float(
            draft.get("review_llm_connectivity_timeout_seconds"),
            float(config.get("review_llm_connectivity_timeout_seconds", 3.0)),
        )

    return config


def _default_port(parsed) -> int:
    if parsed.port:
        return parsed.port
    return 80 if parsed.scheme == "http" else 443


def _provider_warnings(provider: str, request_url: str) -> list[str]:
    warnings = []
    provider_path = urlparse(str(provider or "")).path.rstrip("/").lower()
    request_path = urlparse(str(request_url or "")).path.rstrip("/").lower()
    if provider_path.endswith("/responses"):
        warnings.append("Provider 看起来是 Responses endpoint；Linkualog 会按 Chat Completions 调用，建议填写 /v1 或 /v1/chat/completions。")
    if request_path.endswith("/responses/chat/completions"):
        warnings.append("实际请求地址包含 /responses/chat/completions，通常表示 Provider 路径填错。")
    return warnings


def _base_result(kind: str, config: dict) -> tuple[dict, str, str, str]:
    provider = str(config.get("provider") or "").strip()
    model = str(config.get("model") or "").strip()
    request_url = resolve_chat_completions_url(provider)
    result = {
        "kind": kind,
        "provider": provider,
        "request_url": request_url,
        "model": model,
        "warnings": _provider_warnings(provider, request_url),
    }
    return result, provider, request_url, model


def run_llm_config_connectivity_test(draft: dict | None = None) -> dict:
    started = time.perf_counter()
    try:
        config = _merge_draft_config(draft)
        result, _provider, request_url, model = _base_result("connectivity", config)
        if not model:
            raise ValueError("LLM model 未配置")

        parsed = urlparse(request_url)
        host = parsed.hostname
        if not host:
            raise ValueError("LLM provider 地址不合法，无法解析 host")
        port = _default_port(parsed)
        timeout_seconds = _coerce_positive_float(
            config.get("review_llm_connectivity_timeout_seconds"),
            3.0,
        )

        with closing(socket.create_connection((host, port), timeout=timeout_seconds)):
            pass

        result.update({
            "ok": True,
            "host": host,
            "port": port,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
            "message": "TCP 连接成功",
        })
        return result
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        try:
            config = _merge_draft_config(draft)
            result, _provider, request_url, _model = _base_result("connectivity", config)
        except Exception:
            result = {"kind": "connectivity", "warnings": []}
        result.update({
            "ok": False,
            "elapsed_ms": elapsed_ms,
            "error": _clip_text(exc),
        })
        return result


def run_llm_config_minimal_test(draft: dict | None = None) -> dict:
    started = time.perf_counter()
    response = None
    try:
        config = _merge_draft_config(draft)
        result, _provider, request_url, model = _base_result("minimal", config)
        api_key = str(config.get("api_key") or "").strip()
        if not api_key:
            raise ValueError("未配置 master-server 的 API Key")
        if not model:
            raise ValueError("LLM model 未配置")

        timeout_seconds = _coerce_positive_float(
            config.get("review_llm_timeout_seconds"),
            75.0,
        )
        connect_timeout = min(max(3.0, timeout_seconds / 3), 10.0)
        payload = {
            "model": model,
            "max_tokens": 32,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "You are a strict JSON responder."},
                {"role": "user", "content": MINIMAL_TEST_PROMPT},
            ],
        }
        response = requests.post(
            request_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=(connect_timeout, timeout_seconds),
        )
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        result.update({
            "status_code": response.status_code,
            "elapsed_ms": elapsed_ms,
        })

        if response.status_code >= 400:
            result.update({
                "ok": False,
                "error": f"HTTP {response.status_code}",
                "body_excerpt": _clip_text(response.text),
            })
            return result

        body = response.json()
        try:
            content = body["choices"][0]["message"]["content"]
        except Exception as exc:
            result.update({
                "ok": False,
                "response_schema": "unknown",
                "error": "LLM 响应结构不符合 Chat Completions 预期，缺少 choices[0].message.content",
                "body_excerpt": _clip_text(json.dumps(body, ensure_ascii=False)),
            })
            return result

        content_text = _extract_message_content(content)
        parsed_reply = _parse_json_reply(content_text)
        ok = isinstance(parsed_reply, dict) and parsed_reply.get("ok") is True
        result.update({
            "ok": ok,
            "response_schema": "chat_completions",
            "content_excerpt": _clip_text(content_text, limit=240),
            "message": "最小 JSON 响应通过" if ok else "已返回 Chat Completions 结构，但内容未匹配最小 JSON",
        })
        if not ok:
            result["error"] = "响应内容不是预期的 {\"ok\": true}"
        return result
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        try:
            config = _merge_draft_config(draft)
            result, _provider, request_url, _model = _base_result("minimal", config)
        except Exception:
            result = {"kind": "minimal", "warnings": []}
        result.update({
            "ok": False,
            "elapsed_ms": elapsed_ms,
            "error": _clip_text(exc),
        })
        if response is not None:
            result["status_code"] = getattr(response, "status_code", None)
            result["body_excerpt"] = _clip_text(getattr(response, "text", ""))
        return result
