import json
import logging
import os
import re
import socket
import threading
import time
import requests
from requests.adapters import HTTPAdapter
from urllib.parse import urlparse

from core.config import get_config_data

logger = logging.getLogger("review_agent.llm")
LETTER_WORD_PATTERN = re.compile(r"^[a-z]+$")


def _read_bool_env(name: str, default: bool) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _read_float_env(name: str, default: float) -> float:
    raw = str(os.environ.get(name, "")).strip()
    if not raw:
        return default
    try:
        value = float(raw)
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    return default


def _read_int_env(name: str, default: int) -> int:
    raw = str(os.environ.get(name, "")).strip()
    if not raw:
        return default
    try:
        value = int(raw)
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    return default


DEFAULT_LLM_TIMEOUT_SECONDS = _read_float_env("REVIEW_SERVER_LLM_TIMEOUT_SECONDS", 75.0)
FOLDER_MERGE_LLM_TIMEOUT_SECONDS = _read_float_env("REVIEW_SERVER_FOLDER_MERGE_LLM_TIMEOUT_SECONDS", 90.0)
FOLDER_MERGE_LLM_MAX_TOKENS = _read_int_env("REVIEW_SERVER_FOLDER_MERGE_LLM_MAX_TOKENS", 900)
FOLDER_MERGE_LLM_MAX_TOKENS_CAP = _read_int_env("REVIEW_SERVER_FOLDER_MERGE_LLM_MAX_TOKENS_CAP", 3200)
FOLDER_MERGE_MAX_SUGGESTIONS = _read_int_env("REVIEW_SERVER_FOLDER_MERGE_MAX_SUGGESTIONS", 40)
FOLDER_MERGE_TEMPERATURE = _read_float_env("REVIEW_SERVER_FOLDER_MERGE_TEMPERATURE", 0.0)
FOLDER_MERGE_WORD_LIMIT = _read_int_env("REVIEW_SERVER_FOLDER_MERGE_WORD_LIMIT", 200)
LLM_CONNECTIVITY_CHECK_ENABLED = _read_bool_env("REVIEW_SERVER_LLM_CONNECTIVITY_CHECK", True)
LLM_CONNECTIVITY_TIMEOUT_SECONDS = _read_float_env("REVIEW_SERVER_LLM_CONNECTIVITY_TIMEOUT_SECONDS", 3.0)
LLM_CONNECTIVITY_STRICT = _read_bool_env("REVIEW_SERVER_LLM_CONNECTIVITY_STRICT", False)
LLM_CONNECTIVITY_PROBE_TTL_SECONDS = _read_float_env("REVIEW_SERVER_LLM_CONNECTIVITY_PROBE_TTL_SECONDS", 180.0)
LLM_REQUEST_MAX_RETRIES = _read_int_env("REVIEW_SERVER_LLM_REQUEST_MAX_RETRIES", 2)
LLM_REQUEST_RETRY_BACKOFF_SECONDS = _read_float_env("REVIEW_SERVER_LLM_REQUEST_RETRY_BACKOFF_SECONDS", 1.0)
LLM_RETRYABLE_HTTP_STATUS = {408, 429, 500, 502, 503, 504}

_HTTP = requests.Session()
_HTTP.mount("http://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0))
_HTTP.mount("https://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0))
_PROBE_CACHE_LOCK = threading.Lock()
_PROBE_CACHE: dict[str, float] = {}


def _clean_llm_json_text(content: str) -> str:
    return content.replace("```json", "").replace("```", "").strip()


def _extract_first_json_block(text: str) -> str:
    raw = str(text or "")
    if not raw:
        return ""

    start = -1
    opener = ""
    for i, ch in enumerate(raw):
        if ch == "{" or ch == "[":
            start = i
            opener = ch
            break
    if start < 0:
        return raw.strip()

    closer = "}" if opener == "{" else "]"
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(raw)):
        ch = raw[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == "\"":
                in_string = False
            continue

        if ch == "\"":
            in_string = True
            continue
        if ch == opener:
            depth += 1
            continue
        if ch == closer:
            depth -= 1
            if depth == 0:
                return raw[start : i + 1].strip()

    return raw[start:].strip()


def _repair_json_text(text: str) -> str:
    repaired = str(text or "").strip()
    if not repaired:
        return repaired

    repaired = (
        repaired.replace("\ufeff", "")
        .replace("“", "\"")
        .replace("”", "\"")
        .replace("’", "'")
        .replace("‘", "'")
    )

    # Python-style literals to JSON literals.
    repaired = re.sub(r"\bNone\b", "null", repaired)
    repaired = re.sub(r"\bTrue\b", "true", repaired)
    repaired = re.sub(r"\bFalse\b", "false", repaired)

    # Unquoted keys: {foo: 1} -> {"foo": 1}
    repaired = re.sub(r'([{\s,])([A-Za-z_][A-Za-z0-9_\-]*)\s*:', r'\1"\2":', repaired)
    # Single-quoted keys: {'foo': 1} -> {"foo": 1}
    repaired = re.sub(r"([{\s,])'([^'\\]+)'\s*:", r'\1"\2":', repaired)

    # Trailing commas: {"a":1,} / [1,2,]
    repaired = re.sub(r",(\s*[}\]])", r"\1", repaired)
    return repaired


def _clip_text(text: str, limit: int = 900) -> str:
    value = str(text or "")
    if len(value) <= limit:
        return value
    return f"{value[:limit]}...(truncated,total={len(value)})"


def _parse_llm_json(content: str, request_tag: str = "unknown") -> dict:
    clean = _clean_llm_json_text(content)
    candidates = []

    if clean:
        candidates.append(clean)
    block = _extract_first_json_block(clean)
    if block and block not in candidates:
        candidates.append(block)
    repaired = _repair_json_text(block or clean)
    if repaired and repaired not in candidates:
        candidates.append(repaired)

    last_error = None
    for idx, candidate in enumerate(candidates, start=1):
        try:
            return json.loads(candidate)
        except Exception as exc:
            last_error = exc
            logger.warning(
                "[LLM][%s] JSON candidate parse failed (candidate=%s, length=%s): %s",
                request_tag,
                idx,
                len(candidate),
                exc,
            )
            continue

    raw_excerpt = _clip_text(clean.replace("\n", "\\n"), limit=900)
    raise ValueError(f"LLM JSON 解析失败: {last_error}; raw_excerpt={raw_excerpt}")


def _normalize_merge_word(raw_word: str) -> str | None:
    token = str(raw_word or "").strip().lower()
    token = token.replace("’", "'").replace("`", "'")
    if not LETTER_WORD_PATTERN.match(token):
        return None
    if len(token) < 3:
        return None
    return token


def _append_unique(candidates: list[str], value: str, source_word: str) -> None:
    if value == source_word:
        return
    if len(value) < 3:
        return
    if not LETTER_WORD_PATTERN.match(value):
        return
    if value not in candidates:
        candidates.append(value)


def _looks_like_double_consonant(token: str) -> bool:
    return len(token) >= 2 and token[-1] == token[-2] and token[-1] not in "aeiou"


def _should_ing_add_e(stem: str) -> bool:
    if len(stem) < 2:
        return False
    if stem.endswith("at") and len(stem) > 4 and stem[-3] not in "aeiou":
        return True
    if stem.endswith(("ng", "rk", "lk", "nk", "ck", "sk", "sh", "ch")):
        return False
    if stem[-1] not in {"k", "v", "z", "s", "r", "c", "g"}:
        return False
    return stem[-2] in "aeiouy"


def _merge_target_candidates(word: str) -> list[str]:
    candidates: list[str] = []
    is_ied_form = word.endswith("ied") and len(word) > 4
    is_ies_form = word.endswith("ies") and len(word) > 4
    is_ier_form = word.endswith("ier") and len(word) > 4
    is_iest_form = word.endswith("iest") and len(word) > 5

    if is_ied_form:
        _append_unique(candidates, word[:-3] + "y", word)
    if is_ies_form:
        _append_unique(candidates, word[:-3] + "y", word)
    if is_ier_form:
        _append_unique(candidates, word[:-3] + "y", word)
    if is_iest_form:
        _append_unique(candidates, word[:-4] + "y", word)

    if word.endswith("ing") and len(word) > 5:
        stem = word[:-3]
        if _looks_like_double_consonant(stem):
            _append_unique(candidates, stem[:-1], word)
        if _should_ing_add_e(stem):
            _append_unique(candidates, stem + "e", word)
        _append_unique(candidates, stem, word)

    if word.endswith("ed") and len(word) > 4 and not is_ied_form:
        stem = word[:-2]
        if stem.endswith("at") and len(stem) > 4 and stem[-3] not in "aeiou":
            _append_unique(candidates, stem + "e", word)
        if stem.endswith("dg") or stem.endswith("v"):
            _append_unique(candidates, stem + "e", word)
        if len(word) >= 3 and word[-3] == "e":
            _append_unique(candidates, word[:-1], word)
        if _looks_like_double_consonant(stem):
            _append_unique(candidates, stem[:-1], word)
        _append_unique(candidates, stem, word)

    if word.endswith("es") and len(word) > 4 and not is_ies_form:
        _append_unique(candidates, word[:-2], word)
    if word.endswith("s") and len(word) > 3 and not is_ies_form:
        _append_unique(candidates, word[:-1], word)
    if word.endswith("er") and len(word) > 4 and not is_ier_form:
        stem = word[:-2]
        if _looks_like_double_consonant(stem):
            _append_unique(candidates, stem[:-1], word)
        _append_unique(candidates, stem, word)
        _append_unique(candidates, stem + "e", word)
    if word.endswith("est") and len(word) > 5 and not is_iest_form:
        stem = word[:-3]
        if _looks_like_double_consonant(stem):
            _append_unique(candidates, stem[:-1], word)
        _append_unique(candidates, stem, word)
        _append_unique(candidates, stem + "e", word)

    return candidates


def _select_folder_merge_words(entries: list[tuple[str, dict]]) -> tuple[list[str], int]:
    words = []
    for file_path, payload in entries:
        file_name = str(file_path).split("/")[-1]
        fallback = file_name.replace(".json", "")
        word = str((payload or {}).get("word") or fallback).strip() or fallback
        token = _normalize_merge_word(word)
        if token:
            words.append(token)

    unique_words = sorted(set(words))
    if len(unique_words) <= 1:
        return unique_words, len(unique_words)

    word_set = set(unique_words)
    selected = set()
    for word in unique_words:
        targets = _merge_target_candidates(word)
        if not targets:
            continue
        selected.add(word)
        for candidate in targets:
            if candidate in word_set:
                selected.add(candidate)

    if len(selected) >= 2:
        scoped_words = sorted(selected)
    else:
        scoped_words = unique_words

    original_count = len(scoped_words)
    if len(scoped_words) > FOLDER_MERGE_WORD_LIMIT:
        # Keep words that are more likely to be inflected forms when prompt budget is tight.
        suffix_priority = ("ied", "ies", "ing", "ed", "es", "s", "er", "est")
        prioritized = sorted(
            scoped_words,
            key=lambda word: (not any(word.endswith(suffix) for suffix in suffix_priority), len(word), word),
        )
        scoped_words = sorted(prioritized[:FOLDER_MERGE_WORD_LIMIT])

    return scoped_words, original_count


def _estimate_folder_merge_max_tokens(word_count: int) -> int:
    # Keep enough output budget for a full JSON object with multiple suggestions.
    suggestion_budget = min(FOLDER_MERGE_MAX_SUGGESTIONS, 80)
    estimated = 240 + suggestion_budget * 42 + min(word_count, 200) * 2
    estimated = max(FOLDER_MERGE_LLM_MAX_TOKENS, estimated)
    estimated = min(max(estimated, 512), FOLDER_MERGE_LLM_MAX_TOKENS_CAP)
    return estimated


def _probe_provider_connectivity(provider: str, request_tag: str = "unknown") -> None:
    if not LLM_CONNECTIVITY_CHECK_ENABLED:
        logger.debug("[LLM][%s] Connectivity probe skipped by config", request_tag)
        return

    parsed = urlparse(str(provider or "").strip())
    host = parsed.hostname
    if not host:
        raise ValueError("LLM provider 地址不合法，无法执行连通性测试")

    if parsed.port:
        port = parsed.port
    elif parsed.scheme == "http":
        port = 80
    else:
        port = 443
    cache_key = f"{host}:{port}"

    if LLM_CONNECTIVITY_PROBE_TTL_SECONDS > 0:
        with _PROBE_CACHE_LOCK:
            last_success = _PROBE_CACHE.get(cache_key, 0.0)
        age = time.time() - last_success
        if last_success > 0 and age <= LLM_CONNECTIVITY_PROBE_TTL_SECONDS:
            logger.debug(
                "[LLM][%s] Connectivity probe skipped by cache host=%s port=%s age=%.1fs",
                request_tag,
                host,
                port,
                age,
            )
            return

    probe_start = time.perf_counter()
    logger.info("[LLM][%s] Connectivity probe start host=%s port=%s timeout=%.1fs", request_tag, host, port, LLM_CONNECTIVITY_TIMEOUT_SECONDS)
    try:
        with socket.create_connection((host, port), timeout=LLM_CONNECTIVITY_TIMEOUT_SECONDS):
            elapsed_ms = int((time.perf_counter() - probe_start) * 1000)
            with _PROBE_CACHE_LOCK:
                _PROBE_CACHE[cache_key] = time.time()
            logger.info("[LLM][%s] Connectivity probe success host=%s port=%s elapsed=%sms", request_tag, host, port, elapsed_ms)
            return
    except OSError as exc:
        elapsed_ms = int((time.perf_counter() - probe_start) * 1000)
        log_fn = logger.error if LLM_CONNECTIVITY_STRICT else logger.warning
        log_fn(
            "[LLM][%s] Connectivity probe failed host=%s port=%s elapsed=%sms error=%s",
            request_tag,
            host,
            port,
            elapsed_ms,
            exc,
        )
        if LLM_CONNECTIVITY_STRICT:
            raise ConnectionError(
                f"LLM 服务连通性测试失败: {host}:{port} ({exc})"
            ) from exc


def _extract_message_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "".join(parts).strip()
    return str(content or "").strip()


def _call_llm_json(
    prompt: str,
    max_tokens: int = 1200,
    timeout_seconds: float | None = None,
    temperature: float = 0.1,
    request_tag: str = "unknown",
) -> dict:
    config = get_config_data()
    api_key = config.get("api_key")
    provider = config.get("provider")
    model = config.get("model")

    if not api_key:
        raise ValueError("未配置 review-agent 的 API Key")
    if not provider or not model:
        raise ValueError("LLM provider/model 未配置")
    _probe_provider_connectivity(provider, request_tag=request_tag)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": "你是严格的 JSON 响应器。"},
            {"role": "user", "content": prompt},
        ],
    }

    final_timeout = timeout_seconds if timeout_seconds is not None else DEFAULT_LLM_TIMEOUT_SECONDS
    connect_timeout = min(max(3.0, final_timeout / 3), 10.0)
    logger.info(
        "[LLM][%s] Request start provider=%s model=%s prompt_len=%s max_tokens=%s temperature=%.2f connect_timeout=%.1fs read_timeout=%.1fs max_retries=%s",
        request_tag,
        provider,
        model,
        len(prompt),
        max_tokens,
        temperature,
        connect_timeout,
        final_timeout,
        LLM_REQUEST_MAX_RETRIES,
    )
    max_attempts = max(1, LLM_REQUEST_MAX_RETRIES)
    response = None
    last_error: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        request_start = time.perf_counter()
        try:
            response = _HTTP.post(
                provider,
                headers=headers,
                json=payload,
                timeout=(connect_timeout, final_timeout),
            )
            elapsed_ms = int((time.perf_counter() - request_start) * 1000)
            logger.info(
                "[LLM][%s] Response received attempt=%s/%s status=%s elapsed=%sms",
                request_tag,
                attempt,
                max_attempts,
                response.status_code,
                elapsed_ms,
            )
        except requests.exceptions.Timeout as exc:
            elapsed_ms = int((time.perf_counter() - request_start) * 1000)
            last_error = exc
            logger.warning(
                "[LLM][%s] Request timeout attempt=%s/%s elapsed=%sms read_timeout=%.1fs error=%s",
                request_tag,
                attempt,
                max_attempts,
                elapsed_ms,
                final_timeout,
                exc,
            )
            if attempt >= max_attempts:
                raise TimeoutError(f"LLM 请求超时（{int(final_timeout)}s）") from exc
            sleep_seconds = LLM_REQUEST_RETRY_BACKOFF_SECONDS * attempt
            time.sleep(sleep_seconds)
            continue
        except requests.exceptions.RequestException as exc:
            elapsed_ms = int((time.perf_counter() - request_start) * 1000)
            last_error = exc
            logger.warning(
                "[LLM][%s] Request failed attempt=%s/%s elapsed=%sms error=%s",
                request_tag,
                attempt,
                max_attempts,
                elapsed_ms,
                exc,
            )
            if attempt >= max_attempts:
                raise
            sleep_seconds = LLM_REQUEST_RETRY_BACKOFF_SECONDS * attempt
            time.sleep(sleep_seconds)
            continue

        if response.status_code in LLM_RETRYABLE_HTTP_STATUS and attempt < max_attempts:
            body_excerpt = _clip_text(response.text.replace("\n", "\\n"), limit=300)
            logger.warning(
                "[LLM][%s] Retryable status attempt=%s/%s status=%s body=%s",
                request_tag,
                attempt,
                max_attempts,
                response.status_code,
                body_excerpt,
            )
            sleep_seconds = LLM_REQUEST_RETRY_BACKOFF_SECONDS * attempt
            time.sleep(sleep_seconds)
            continue
        break

    if response is None:
        if last_error is not None:
            raise last_error
        raise RuntimeError("LLM 请求失败，未收到响应")

    response.raise_for_status()

    body = response.json()
    try:
        content = body["choices"][0]["message"]["content"]
    except Exception as exc:
        logger.error("[LLM][%s] Invalid response schema keys=%s error=%s", request_tag, list(body.keys()), exc)
        raise ValueError("LLM 响应结构不符合预期，缺少 choices[0].message.content") from exc

    raw = _extract_message_content(content)
    logger.info("[LLM][%s] Response content extracted chars=%s", request_tag, len(raw))
    try:
        parsed = _parse_llm_json(raw, request_tag=request_tag)
    except Exception as exc:
        logger.error(
            "[LLM][%s] JSON parse failed raw_excerpt=%s",
            request_tag,
            _clip_text(raw.replace("\n", "\\n"), limit=1200),
        )
        raise
    if isinstance(parsed, dict):
        logger.info("[LLM][%s] Response JSON parsed keys=%s", request_tag, list(parsed.keys()))
    else:
        logger.info("[LLM][%s] Response JSON parsed type=%s", request_tag, type(parsed).__name__)
    return parsed


def suggest_folder_merge_with_llm(entries: list[tuple[str, dict]]) -> dict:
    unique_words, original_scoped_count = _select_folder_merge_words(entries)
    if len(unique_words) <= 1:
        return {"suggestions": [], "notes": ["词条数量不足，跳过 LLM 词形合并分析"]}

    max_tokens = _estimate_folder_merge_max_tokens(len(unique_words))
    prompt = (
        "Return VALID JSON only. No markdown, no comments, no trailing commas, and all keys must use double quotes.\n"
        "Task: from input words, suggest inflection merges only (singular/plural, 3rd-person -s/-es, -ies/-ied, tense -ed, progressive -ing, comparative -er, superlative -est). Avoid semantic mistakes.\n"
        "Rules:\n"
        "1) source_word and target_word must both be lowercase a-z words (single token).\n"
        "2) source_word must be from words.\n"
        "3) target_word should be lemma. If not in words, set create_target_if_missing=true.\n"
        "4) confidence is 0..1.\n"
        f"5) return at most {FOLDER_MERGE_MAX_SUGGESTIONS} suggestions.\n"
        "6) Keep reason short (<= 16 Chinese chars or <= 32 ASCII chars).\n"
        "7) Do not output duplicated source_word + target_word pairs.\n"
        "8) Comparative/superlative forms should merge back to the base form, but do not merge derivational or part-of-speech changes such as -ly adverb/adjective, agentive -er nouns, noun/verb pairs, or adjective/verb pairs.\n"
        "Output EXACT schema:\n"
        "{\"suggestions\":[{\"source_word\":\"x\",\"target_word\":\"y\",\"create_target_if_missing\":false,\"confidence\":0.82,\"reason\":\"...\"}],\"notes\":[]}\n"
        f"words={json.dumps(unique_words, ensure_ascii=False, separators=(',', ':'))}"
    )
    result = _call_llm_json(
        prompt,
        max_tokens=max_tokens,
        timeout_seconds=FOLDER_MERGE_LLM_TIMEOUT_SECONDS,
        temperature=FOLDER_MERGE_TEMPERATURE,
        request_tag="folder_merge",
    )
    if not isinstance(result, dict):
        return result

    notes = result.get("notes")
    if not isinstance(notes, list):
        notes = []

    if original_scoped_count > len(unique_words):
        notes.append(
            f"LLM 输入词数已裁剪: {len(unique_words)}/{original_scoped_count}（仅保留词形归并相关词）"
        )
    result["notes"] = notes
    return result


def _safe_string(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _parse_non_negative_int(value) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    return number


def _normalize_text_list(value) -> list[str]:
    if not isinstance(value, list):
        return []

    result = []
    seen = set()
    for item in value:
        text = _safe_string(item)
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _first_non_empty_text(*values) -> str:
    for value in values:
        text = _safe_string(value)
        if text:
            return text
    return ""


def _definition_suggestion_list(item: dict) -> list[str]:
    candidates = [
        item.get("suggested_definitions"),
        item.get("definitions"),
        item.get("values"),
        item.get("items"),
    ]
    for candidate in candidates:
        values = _normalize_text_list(candidate)
        if values:
            return values

    suggested = item.get("suggested")
    if isinstance(suggested, list):
        values = _normalize_text_list(suggested)
        if values:
            return values

    single = _first_non_empty_text(
        item.get("suggested"),
        item.get("definition"),
        item.get("replacement"),
        item.get("value"),
        item.get("text"),
        item.get("new_definition"),
    )
    if single:
        return [single]
    return []


def _normalize_definition_action(raw_action: str, *, has_index: bool, has_list: bool, has_single: bool) -> str:
    action = _safe_string(raw_action).lower().replace("-", "_")
    mapping = {
        "keep": "keep",
        "noop": "keep",
        "ignore": "keep",
        "drop": "drop",
        "delete": "drop",
        "remove": "drop",
        "merge": "replace",
        "rewrite": "replace",
        "replace": "replace",
        "update": "replace",
        "modify": "replace",
        "trim": "replace",
        "append": "append",
        "add": "append",
        "insert": "append",
        "create": "append",
        "new": "append",
        "replace_all": "replace_all",
        "rewrite_all": "replace_all",
        "reset": "replace_all",
    }
    normalized = mapping.get(action, "")
    if normalized:
        return normalized
    if has_list:
        return "replace_all"
    if has_index and has_single:
        return "replace"
    if has_single:
        return "append"
    return ""


def _normalize_example_action(raw_action: str, *, has_text: bool, has_explanation: bool) -> str:
    action = _safe_string(raw_action).lower().replace("-", "_")
    mapping = {
        "keep": "keep",
        "noop": "keep",
        "ignore": "keep",
        "drop": "drop",
        "delete": "drop",
        "remove": "drop",
        "trim": "trim",
        "rewrite": "rewrite",
        "replace": "rewrite",
        "update": "rewrite",
        "modify": "rewrite",
    }
    normalized = mapping.get(action, "")
    if normalized:
        return normalized
    if has_text or has_explanation:
        return "rewrite"
    return ""


def _normalize_definition_suggestions(raw_items) -> list[dict]:
    if not isinstance(raw_items, list):
        return []

    normalized: list[dict] = []
    seen = set()

    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue

        reason = _first_non_empty_text(raw_item.get("reason"), raw_item.get("note"))
        index = _parse_non_negative_int(raw_item.get("index"))
        indices = sorted(
            {
                parsed
                for parsed in (
                    _parse_non_negative_int(item)
                    for item in (raw_item.get("indices") if isinstance(raw_item.get("indices"), list) else [])
                )
                if parsed is not None
            }
        )
        suggested_values = _definition_suggestion_list(raw_item)
        has_single = bool(suggested_values[:1])
        has_list = len(suggested_values) > 1
        action = _normalize_definition_action(
            raw_item.get("action", raw_item.get("op", raw_item.get("type"))),
            has_index=index is not None,
            has_list=has_list,
            has_single=has_single,
        )

        if action == "keep" or not action:
            continue

        if action == "replace_all":
            payload = {
                "action": "replace_all",
                "reason": reason,
                "suggested_definitions": suggested_values,
            }
            key = ("replace_all", tuple(suggested_values))
            if suggested_values and key not in seen:
                seen.add(key)
                normalized.append(payload)
            continue

        if action == "append":
            for value in suggested_values:
                key = ("append", value)
                if not value or key in seen:
                    continue
                seen.add(key)
                normalized.append(
                    {
                        "action": "append",
                        "reason": reason,
                        "suggested": value,
                    }
                )
            continue

        target_indices = indices or ([index] if index is not None else [])
        if not target_indices:
            continue

        if action == "drop":
            for target_index in target_indices:
                key = ("drop", target_index)
                if key in seen:
                    continue
                seen.add(key)
                normalized.append(
                    {
                        "action": "drop",
                        "index": target_index,
                        "reason": reason,
                    }
                )
            continue

        if action == "replace":
            if not suggested_values:
                continue
            first_value = suggested_values[0]
            for target_index in target_indices:
                key = ("replace", target_index, first_value)
                if key in seen:
                    continue
                seen.add(key)
                normalized.append(
                    {
                        "action": "replace",
                        "index": target_index,
                        "reason": reason,
                        "suggested": first_value,
                    }
                )

    return normalized


def _normalize_example_suggestions(raw_items) -> list[dict]:
    if not isinstance(raw_items, list):
        return []

    normalized: list[dict] = []
    seen = set()

    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue

        index = _parse_non_negative_int(raw_item.get("index"))
        if index is None:
            continue

        suggested_text = _first_non_empty_text(
            raw_item.get("suggested_text"),
            raw_item.get("text"),
            raw_item.get("suggested"),
            raw_item.get("replacement"),
            raw_item.get("value"),
        )
        suggested_explanation = _first_non_empty_text(
            raw_item.get("suggested_explanation"),
            raw_item.get("explanation"),
        )
        action = _normalize_example_action(
            raw_item.get("action", raw_item.get("op", raw_item.get("type"))),
            has_text=bool(suggested_text),
            has_explanation=bool(suggested_explanation),
        )
        if action == "keep" or not action:
            continue

        payload = {
            "index": index,
            "action": action,
            "reason": _first_non_empty_text(raw_item.get("reason"), raw_item.get("note")),
        }
        if suggested_text:
            payload["suggested_text"] = suggested_text
        if suggested_explanation:
            payload["suggested_explanation"] = suggested_explanation

        key = (
            payload["action"],
            payload["index"],
            payload.get("suggested_text", ""),
            payload.get("suggested_explanation", ""),
        )
        if key in seen:
            continue
        seen.add(key)
        normalized.append(payload)

    return normalized


def _normalize_file_cleaning_result(raw_result) -> dict:
    if not isinstance(raw_result, dict):
        return {"definitions": [], "examples": [], "global_notes": []}

    return {
        "definitions": _normalize_definition_suggestions(raw_result.get("definitions")),
        "examples": _normalize_example_suggestions(raw_result.get("examples")),
        "global_notes": _normalize_text_list(raw_result.get("global_notes")),
    }


def suggest_file_cleaning_with_llm(word: str, definitions: list[str], examples: list[dict]) -> dict:
    prompt = (
        "你是英文词库数据治理助手。"
        "请只输出 JSON，不要输出 markdown。"
        "任务：根据给定词条，给出数据清洗建议，重点关注："
        "1) 释义重复/无必要；2) 例句上下文可精简；3) 空或无效 explanation。"
        "输出结构："
        '{"definitions":[{"action":"replace|append|drop|replace_all","index":0,"reason":"...","suggested":"...","suggested_definitions":["..."]}],'
        '"examples":[{"index":0,"action":"keep|trim|drop|rewrite","reason":"...","suggested_text":"...","suggested_explanation":"..."}],'
        '"global_notes":["..."]}'
        "Definitions 规则：replace 仅修改 index 对应释义；append 追加一条新释义；drop 删除 index；"
        "只有当整组 definitions 都应该重写时才使用 replace_all，并填写 suggested_definitions 数组。"
        f"词条: {word}\n"
        f"definitions: {json.dumps(definitions, ensure_ascii=False)}\n"
        f"examples: {json.dumps(examples, ensure_ascii=False)}"
    )

    result = _call_llm_json(prompt, request_tag="file_cleaning")
    return _normalize_file_cleaning_result(result)
