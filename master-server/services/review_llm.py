import json
import logging
import re
import socket
import threading
import time
import requests
from requests.adapters import HTTPAdapter
from urllib.parse import urlparse

from core.config import get_config_data
from services.lemma_dictionary import get_lemma_words

logger = logging.getLogger("master_server.review.llm")
LETTER_WORD_PATTERN = re.compile(r"^[a-z]+$")


LLM_RETRYABLE_HTTP_STATUS = {408, 429, 500, 502, 503, 504}

_HTTP = requests.Session()
_HTTP.mount("http://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0))
_HTTP.mount("https://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0))
_PROBE_CACHE_LOCK = threading.Lock()
_PROBE_CACHE: dict[str, float] = {}


def _runtime_settings() -> dict:
    config = get_config_data()
    return {
        "default_timeout_seconds": float(config.get("review_llm_timeout_seconds", 75.0)),
        "folder_merge_llm_timeout_seconds": float(config.get("review_folder_merge_llm_timeout_seconds", 90.0)),
        "folder_merge_llm_max_tokens": int(config.get("review_folder_merge_llm_max_tokens", 900)),
        "folder_merge_llm_max_tokens_cap": int(config.get("review_folder_merge_llm_max_tokens_cap", 3200)),
        "folder_merge_max_suggestions": int(config.get("review_folder_merge_max_suggestions", 40)),
        "folder_merge_temperature": float(config.get("review_folder_merge_temperature", 0.0)),
        "folder_merge_word_limit": int(config.get("review_folder_merge_word_limit", 200)),
        "llm_connectivity_check": bool(config.get("review_llm_connectivity_check", True)),
        "llm_connectivity_timeout_seconds": float(config.get("review_llm_connectivity_timeout_seconds", 3.0)),
        "llm_connectivity_strict": bool(config.get("review_llm_connectivity_strict", False)),
        "llm_connectivity_probe_ttl_seconds": float(config.get("review_llm_connectivity_probe_ttl_seconds", 180.0)),
        "llm_request_max_retries": int(config.get("review_llm_request_max_retries", 2)),
        "llm_request_retry_backoff_seconds": float(config.get("review_llm_request_retry_backoff_seconds", 1.0)),
    }


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


def _merge_reason(source: str, target: str) -> str:
    if source.endswith("ied") and target == source[:-3] + "y":
        return "-ied 词形回退到 -y 原形"
    if source.endswith("ing"):
        stem = source[:-3]
        if target in {stem, stem + "e"}:
            return "现在分词/动名词回退到动词原形"
        if _looks_like_double_consonant(stem) and target == stem[:-1]:
            return "现在分词/动名词回退到动词原形"
    if source.endswith("ed"):
        stem = source[:-2]
        if target in {stem, stem + "e"}:
            return "过去式/过去分词回退到动词原形"
        if len(source) >= 3 and source[-3] == "e" and target == source[:-1]:
            return "过去式/过去分词回退到动词原形"
        if _looks_like_double_consonant(stem) and target == stem[:-1]:
            return "过去式/过去分词回退到动词原形"
    if source.endswith("ies") and target == source[:-3] + "y":
        return "复数 -ies 回退到单数 -y"
    if source.endswith("s") and target == source[:-1]:
        return "第三人称/复数回退到原形"
    if source.endswith("ier") and target == source[:-3] + "y":
        return "比较级回退到形容词原形"
    if source.endswith("iest") and target == source[:-4] + "y":
        return "最高级回退到形容词原形"
    if source.endswith("er") and target in {source[:-2], source[:-2] + "e"}:
        return "比较级回退到形容词原形"
    if source.endswith("est") and target in {source[:-3], source[:-3] + "e"}:
        return "最高级回退到形容词原形"
    return "通用词形回退"


def _dictionary_merge_target_candidates(word: str, known_lemmas: set[str] | frozenset[str]) -> list[str]:
    return [
        candidate
        for candidate in _merge_target_candidates(word)
        if candidate in known_lemmas
    ]


def get_dictionary_merge_target_candidates(word: str) -> list[str]:
    token = _normalize_merge_word(word)
    if not token:
        return []
    return _dictionary_merge_target_candidates(token, get_lemma_words())


def _select_folder_merge_words(entries: list[tuple[str, dict]], word_limit: int) -> tuple[list[str], int]:
    words = []
    for file_path, payload in entries:
        file_name = str(file_path).split("/")[-1]
        fallback = file_name.replace(".json", "")
        word = str((payload or {}).get("word") or fallback).strip() or fallback
        token = _normalize_merge_word(word)
        if token:
            words.append(token)

    unique_words = sorted(set(words))
    if not unique_words:
        return unique_words, 0

    word_set = set(unique_words)
    known_lemmas = get_lemma_words()
    selected = set()
    for word in unique_words:
        targets = _dictionary_merge_target_candidates(word, known_lemmas)
        if not targets:
            continue
        selected.add(word)
        for candidate in targets:
            if candidate in word_set:
                selected.add(candidate)

    if selected:
        scoped_words = sorted(selected)
    else:
        scoped_words = []

    original_count = len(scoped_words)
    if len(scoped_words) > word_limit:
        # Keep words that are more likely to be inflected forms when prompt budget is tight.
        suffix_priority = ("ied", "ies", "ing", "ed", "es", "s", "er", "est")
        prioritized = sorted(
            scoped_words,
            key=lambda word: (not any(word.endswith(suffix) for suffix in suffix_priority), len(word), word),
        )
        scoped_words = sorted(prioritized[:word_limit])

    return scoped_words, original_count


def _estimate_folder_merge_max_tokens(word_count: int, settings: dict) -> int:
    # Keep enough output budget for a full JSON object with multiple suggestions.
    suggestion_budget = min(int(settings["folder_merge_max_suggestions"]), 80)
    estimated = 240 + suggestion_budget * 42 + min(word_count, 200) * 2
    estimated = max(int(settings["folder_merge_llm_max_tokens"]), estimated)
    estimated = min(max(estimated, 512), int(settings["folder_merge_llm_max_tokens_cap"]))
    return estimated


def _probe_provider_connectivity(provider: str, request_tag: str = "unknown", settings: dict | None = None) -> None:
    settings = settings or _runtime_settings()
    if not settings["llm_connectivity_check"]:
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

    probe_ttl_seconds = float(settings["llm_connectivity_probe_ttl_seconds"])
    if probe_ttl_seconds > 0:
        with _PROBE_CACHE_LOCK:
            last_success = _PROBE_CACHE.get(cache_key, 0.0)
        age = time.time() - last_success
        if last_success > 0 and age <= probe_ttl_seconds:
            logger.debug(
                "[LLM][%s] Connectivity probe skipped by cache host=%s port=%s age=%.1fs",
                request_tag,
                host,
                port,
                age,
            )
            return

    probe_start = time.perf_counter()
    timeout_seconds = float(settings["llm_connectivity_timeout_seconds"])
    logger.info("[LLM][%s] Connectivity probe start host=%s port=%s timeout=%.1fs", request_tag, host, port, timeout_seconds)
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            elapsed_ms = int((time.perf_counter() - probe_start) * 1000)
            with _PROBE_CACHE_LOCK:
                _PROBE_CACHE[cache_key] = time.time()
            logger.info("[LLM][%s] Connectivity probe success host=%s port=%s elapsed=%sms", request_tag, host, port, elapsed_ms)
            return
    except OSError as exc:
        elapsed_ms = int((time.perf_counter() - probe_start) * 1000)
        log_fn = logger.error if settings["llm_connectivity_strict"] else logger.warning
        log_fn(
            "[LLM][%s] Connectivity probe failed host=%s port=%s elapsed=%sms error=%s",
            request_tag,
            host,
            port,
            elapsed_ms,
            exc,
        )
        if settings["llm_connectivity_strict"]:
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
    settings = _runtime_settings()
    config = get_config_data()
    api_key = config.get("api_key")
    provider = config.get("provider")
    model = config.get("model")

    if not api_key:
        raise ValueError("未配置 master-server 的 API Key")
    if not provider or not model:
        raise ValueError("LLM provider/model 未配置")
    _probe_provider_connectivity(provider, request_tag=request_tag, settings=settings)

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

    final_timeout = timeout_seconds if timeout_seconds is not None else float(settings["default_timeout_seconds"])
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
        settings["llm_request_max_retries"],
    )
    max_attempts = max(1, int(settings["llm_request_max_retries"]))
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
            sleep_seconds = float(settings["llm_request_retry_backoff_seconds"]) * attempt
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
            sleep_seconds = float(settings["llm_request_retry_backoff_seconds"]) * attempt
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
            sleep_seconds = float(settings["llm_request_retry_backoff_seconds"]) * attempt
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
    settings = _runtime_settings()
    unique_words, original_scoped_count = _select_folder_merge_words(entries, int(settings["folder_merge_word_limit"]))
    if not unique_words:
        return {"suggestions": [], "notes": ["词条数量不足，跳过 LLM 词形合并分析"]}

    max_tokens = _estimate_folder_merge_max_tokens(len(unique_words), settings)
    known_lemmas = get_lemma_words()
    candidate_map = {
        word: _dictionary_merge_target_candidates(word, known_lemmas)
        for word in unique_words
    }
    candidate_map = {
        word: candidates
        for word, candidates in candidate_map.items()
        if candidates
    }
    if not candidate_map:
        return {"suggestions": [], "notes": ["词典未发现可归并词形，跳过 LLM 词形合并分析"]}
    candidate_details = {
        word: [
            {"target": target, "reason": _merge_reason(word, target)}
            for target in targets
        ]
        for word, targets in candidate_map.items()
    }

    prompt = (
        "Return VALID JSON only. No markdown, no comments, no trailing commas, and all keys must use double quotes.\n"
        "Task: from input words, suggest inflection merges only (singular/plural, 3rd-person -s/-es, -ies/-ied, tense -ed, progressive -ing, comparative -er, superlative -est). Avoid semantic mistakes.\n"
        "Rules:\n"
        "1) source_word and target_word must both be lowercase a-z words (single token).\n"
        "2) source_word must be from words.\n"
        "3) target_word must be one of candidate_targets[source_word]. If not in words, set create_target_if_missing=true.\n"
        "4) confidence is 0..1.\n"
        f"5) return at most {settings['folder_merge_max_suggestions']} suggestions.\n"
        "6) Keep reason short (<= 16 Chinese chars or <= 32 ASCII chars).\n"
        "7) Do not output duplicated source_word + target_word pairs.\n"
        "8) A word can appear in dictionaries and still be an inflected/participial form; rely on candidate_targets, not blind suffix cutting.\n"
        "9) Comparative/superlative forms should merge back to the base form, but do not merge derivational or part-of-speech changes such as -ly adverb/adjective, agentive -er nouns, noun/verb pairs, or adjective/verb pairs.\n"
        "10) Reject pseudo-lemmas made by blindly cutting suffixes, such as bree or underprivileg.\n"
        "Output EXACT schema:\n"
        "{\"suggestions\":[{\"source_word\":\"x\",\"target_word\":\"y\",\"create_target_if_missing\":false,\"confidence\":0.82,\"reason\":\"...\"}],\"notes\":[]}\n"
        f"words={json.dumps(unique_words, ensure_ascii=False, separators=(',', ':'))}\n"
        f"candidate_targets={json.dumps(candidate_map, ensure_ascii=False, separators=(',', ':'))}\n"
        f"candidate_details={json.dumps(candidate_details, ensure_ascii=False, separators=(',', ':'))}"
    )
    result = _call_llm_json(
        prompt,
        max_tokens=max_tokens,
        timeout_seconds=float(settings["folder_merge_llm_timeout_seconds"]),
        temperature=float(settings["folder_merge_temperature"]),
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


def _normalize_entry_action(raw_action: str, *, has_suggested_word: bool, has_split_entries: bool) -> str:
    action = _safe_string(raw_action).lower().replace("-", "_")
    mapping = {
        "keep": "keep",
        "noop": "keep",
        "ignore": "keep",
        "rename": "rename",
        "retitle": "rename",
        "headword": "rename",
        "lemmatize": "rename",
        "converge": "rename",
        "split": "split",
        "separate": "split",
        "extract": "split",
        "split_entry": "split",
    }
    normalized = mapping.get(action, "")
    if normalized:
        return normalized
    if has_split_entries:
        return "split"
    if has_suggested_word:
        return "rename"
    return ""


def _normalize_entry_word(raw_word: str) -> str:
    word = _safe_string(raw_word).lower()
    word = word.replace("’", "'").replace("`", "'")
    word = re.sub(r"\s+", " ", word)
    word = re.sub(r"[^a-z0-9\s'\-]+", "", word)
    word = re.sub(r"\s+", " ", word).strip(" -'")
    if not word:
        return ""
    token_count = len(word.split())
    if token_count > 6:
        return ""
    return word


def _entry_suggested_word(raw_item: dict) -> str:
    return _normalize_entry_word(
        _first_non_empty_text(
            raw_item.get("suggested_word"),
            raw_item.get("target_word"),
            raw_item.get("word"),
            raw_item.get("replacement"),
            raw_item.get("value"),
        )
    )


def _normalize_split_entries(raw_entries) -> list[dict]:
    if not isinstance(raw_entries, list):
        return []

    normalized: list[dict] = []
    seen = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue

        word = _normalize_entry_word(_first_non_empty_text(raw_entry.get("word"), raw_entry.get("headword")))
        if not word or word in seen:
            continue
        seen.add(word)

        example_indices = sorted(
            {
                parsed
                for parsed in (
                    _parse_non_negative_int(item)
                    for item in (
                        raw_entry.get("example_indices")
                        if isinstance(raw_entry.get("example_indices"), list)
                        else []
                    )
                )
                if parsed is not None
            }
        )
        single_index = _parse_non_negative_int(raw_entry.get("example_index"))
        if single_index is not None and single_index not in example_indices:
            example_indices.append(single_index)
            example_indices.sort()

        item = {
            "word": word,
            "definitions": _normalize_text_list(raw_entry.get("definitions")),
            "focus_words": _normalize_text_list(raw_entry.get("focus_words")),
            "example_indices": example_indices,
            "reason": _first_non_empty_text(raw_entry.get("reason"), raw_entry.get("note")),
        }
        normalized.append(item)

    return normalized[:4]


def _normalize_entry_suggestions(raw_items) -> list[dict]:
    if not isinstance(raw_items, list):
        return []

    normalized: list[dict] = []
    seen = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue

        suggested_word = _entry_suggested_word(raw_item)
        split_entries = _normalize_split_entries(
            raw_item.get("suggested_entries")
            or raw_item.get("entries")
            or raw_item.get("split_entries")
        )
        action = _normalize_entry_action(
            raw_item.get("action", raw_item.get("op", raw_item.get("type"))),
            has_suggested_word=bool(suggested_word),
            has_split_entries=bool(split_entries),
        )
        if action == "keep" or not action:
            continue

        reason = _first_non_empty_text(raw_item.get("reason"), raw_item.get("note"))
        confidence = raw_item.get("confidence")
        try:
            confidence = max(0.0, min(1.0, float(confidence)))
        except (TypeError, ValueError):
            confidence = 0.7

        if action == "rename":
            if not suggested_word:
                continue
            key = ("rename", suggested_word)
            if key in seen:
                continue
            seen.add(key)
            normalized.append(
                {
                    "action": "rename",
                    "suggested_word": suggested_word,
                    "reason": reason,
                    "confidence": round(confidence, 3),
                }
            )
            continue

        if action == "split":
            if not split_entries:
                continue
            key = ("split", tuple(entry["word"] for entry in split_entries))
            if key in seen:
                continue
            seen.add(key)
            normalized.append(
                {
                    "action": "split",
                    "suggested_entries": split_entries,
                    "reason": reason,
                    "confidence": round(confidence, 3),
                }
            )

    return normalized


def _examples_text_blob(examples: list[dict]) -> str:
    texts = []
    for example in examples if isinstance(examples, list) else []:
        if not isinstance(example, dict):
            continue
        text = _safe_string(example.get("text"))
        if text:
            texts.append(text.lower())
    return "\n".join(texts)


def suggest_entry_quality_with_rules(word: str, definitions: list[str], examples: list[dict]) -> list[dict]:
    normalized_word = _normalize_entry_word(word)
    if not normalized_word:
        return []

    text_blob = _examples_text_blob(examples)
    suggestions: list[dict] = []

    if normalized_word == "elaborate signs" and "elaborate signs, symbols, and sounds" in text_blob:
        suggestions.append(
            {
                "action": "rename",
                "suggested_word": "elaborate",
                "reason": "规则识别：signs 与 symbols、sounds 并列，只是例句宾语；词条应收敛为 elaborate。",
                "confidence": 0.94,
                "source": "rule",
            }
        )

    if normalized_word == "assortment of ailments" and "an assortment of ailments" in text_blob:
        suggestions.append(
            {
                "action": "split",
                "suggested_entries": [
                    {
                        "word": "an assortment of",
                        "definitions": ["各种各样的；一系列不同的"],
                        "focus_words": ["an assortment of"],
                        "example_indices": [0],
                        "reason": "可迁移的数量/集合搭配。",
                    },
                    {
                        "word": "ailment",
                        "definitions": ["小病；不严重的疾病；身体不适"],
                        "focus_words": ["ailments"],
                        "example_indices": [0],
                        "reason": "核心名词，例句中以复数 ailments 出现。",
                    },
                ],
                "reason": "规则识别：当前词条混合了搭配 an assortment of 与名词 ailment，建议拆分。",
                "confidence": 0.94,
                "source": "rule",
            }
        )

    return suggestions


def _normalize_file_cleaning_result(raw_result) -> dict:
    if not isinstance(raw_result, dict):
        return {"entry": [], "definitions": [], "examples": [], "global_notes": []}

    return {
        "entry": _normalize_entry_suggestions(
            raw_result.get("entry")
            or raw_result.get("entries")
            or raw_result.get("entry_actions")
            or raw_result.get("headword")
        ),
        "definitions": _normalize_definition_suggestions(raw_result.get("definitions")),
        "examples": _normalize_example_suggestions(raw_result.get("examples")),
        "global_notes": _normalize_text_list(raw_result.get("global_notes")),
    }


def suggest_missing_definitions_with_llm(word: str, examples: list[dict]) -> list[dict]:
    prompt = (
        "你是英文词库释义补全助手。"
        "请只输出 JSON，不要输出 markdown。"
        "任务：当前词条 definitions 为空，请基于词条和例句生成 1-3 条中文学习释义。"
        "要求：释义必须准确、简洁、中文为主；可以用分号合并常见中文义项；不要输出纯英文。"
        "如果例句中的词形是复数、过去式或分词，释义仍应对应词条原形。"
        '输出结构：{"definitions":[{"action":"append","reason":"...","suggested":"中文释义"}]}'
        f"词条: {word}\n"
        f"examples: {json.dumps(examples, ensure_ascii=False)}"
    )
    result = _call_llm_json(
        prompt,
        max_tokens=500,
        temperature=0.0,
        request_tag="missing_definitions",
    )
    return _normalize_definition_suggestions(
        result.get("definitions") if isinstance(result, dict) else result
    )


def suggest_missing_example_explanations_with_llm(
    word: str,
    examples: list[dict],
    missing_indices: list[int],
) -> list[dict]:
    if not isinstance(examples, list):
        return []

    valid_indices = []
    seen = set()
    for raw_index in missing_indices if isinstance(missing_indices, list) else []:
        index = _parse_non_negative_int(raw_index)
        if index is None or index in seen:
            continue
        if index >= len(examples):
            continue
        example = examples[index]
        if not isinstance(example, dict):
            continue
        if not _safe_string(example.get("text")):
            continue
        valid_indices.append(index)
        seen.add(index)

    if not valid_indices:
        return []

    target_examples = [
        {
            "index": index,
            "text": str(examples[index].get("text") or ""),
            "focusWords": examples[index].get("focusWords") if isinstance(examples[index].get("focusWords"), list) else [],
        }
        for index in valid_indices
    ]
    prompt = (
        "你是英文词库例句讲解补全助手。"
        "请只输出 JSON，不要输出 markdown。"
        "任务：这些例句的 explanation 为空，请为每个给定 index 生成中文讲解。"
        "要求：只解释例句中当前词条或 focusWords 的用法和句意；主体必须是中文；自然、简洁、适合学习者。"
        "不要改写例句 text，不要新增原句没有的信息；如果一个例句无法判断，就不要返回该 index。"
        "每条建议 action 必须使用 rewrite，并只填写 suggested_explanation，不要填写 suggested_text。"
        '输出结构：{"examples":[{"index":0,"action":"rewrite","reason":"...","suggested_explanation":"中文讲解"}]}'
        f"词条: {word}\n"
        f"missing_indices: {json.dumps(valid_indices, ensure_ascii=False)}\n"
        f"examples: {json.dumps(target_examples, ensure_ascii=False)}"
    )
    result = _call_llm_json(
        prompt,
        max_tokens=max(500, min(1200, 260 + len(valid_indices) * 180)),
        temperature=0.0,
        request_tag="missing_example_explanations",
    )
    normalized = _normalize_example_suggestions(
        result.get("examples") if isinstance(result, dict) else result
    )
    valid_set = set(valid_indices)
    return [
        item
        for item in normalized
        if item.get("index") in valid_set and _safe_string(item.get("suggested_explanation"))
    ]


def _compact_rule_suggestions_for_prompt(rule_suggestions: list[dict] | None) -> list[dict]:
    compacted = []
    for item in rule_suggestions if isinstance(rule_suggestions, list) else []:
        if not isinstance(item, dict):
            continue
        compacted.append(
            {
                key: item[key]
                for key in (
                    "type",
                    "action",
                    "severity",
                    "index",
                    "indices",
                    "current",
                    "suggested",
                    "suggested_word",
                    "suggested_entries",
                    "suggested_action",
                    "reason",
                    "confidence",
                    "source",
                )
                if key in item
            }
        )
    return compacted[:20]


def suggest_file_cleaning_with_llm(
    word: str,
    definitions: list[str],
    examples: list[dict],
    rule_suggestions: list[dict] | None = None,
) -> dict:
    rule_context = _compact_rule_suggestions_for_prompt(rule_suggestions)
    prompt = (
        "你是英文词库数据治理助手。"
        "请只输出 JSON，不要输出 markdown。"
        "任务：根据给定词条，给出数据清洗建议，重点关注："
        "1) 词条 headword 是否错切、过宽或混入无关搭配词；2) 释义重复/无必要；"
        "3) 例句上下文可精简；4) 空或无效 explanation。"
        "词条规则：必须结合 examples 判断词条是否是真正应记忆的单位。"
        "如果词条只是“核心词 + 例句里碰巧出现的普通名词/宾语”，应建议 rename 到核心词。"
        "例如 elaborate signs 出现在 elaborate signs, symbols, and sounds 中时，signs 只是并列对象，建议 rename 为 elaborate。"
        "如果当前词条把两个独立学习点揉在一起，应建议 split，并给出拆分后的词条。"
        "例如 assortment of ailments 来自 detect an assortment of ailments 时，通常应拆成 an assortment of 与 ailment。"
        "不要把固定短语、习语、动词短语或真实搭配误拆；不确定时只写 global_notes，不给可执行 entry 建议。"
        "风格要求：所有 suggested / suggested_definitions / suggested_explanation 都必须保持中文学习友好。"
        "如果 definitions 为空或缺少有效中文释义，必须基于词条与 examples 给出 definitions 建议："
        "优先使用 append 追加一条中文释义；如果需要多条释义，使用 replace_all 并填写 suggested_definitions。"
        "如果你改写 definitions，新内容必须包含明确中文释义，可以附带极短英文提示，但不能只有英文。"
        "如果你改写 explanation，新内容必须是自然、完整、易懂的中文，必要时可在括号里保留极短英文提示，但主体必须是中文。"
        "不要把 definitions 或 explanation 改写成纯英文笔记、词根说明或过长段落。"
        "如果原始内容已经清晰且中文信息充分，就不要为了统一风格硬改。"
        "例句规则：默认优先 keep；只有在原句明显冗余、语病明显、截断错误或含有无关噪音时，才使用 trim / rewrite。"
        "如果某个 example 的 explanation 为空，但 text 有效，必须为该 index 返回 examples 建议：action 使用 rewrite，填写 suggested_explanation；不要填写 suggested_text，除非原 text 本身也必须修改。"
        "如果只是 explanation 需要修改，就不要顺手改 suggested_text。"
        "如果需要改 suggested_text，必须尽量做最小改动：保留原句核心措辞、语气、时态、主语和事实，不要擅自换同义表达、补背景、扩写细节、改写成更地道但更远离原文的新句子。"
        "严禁为了追求自然度而过度发挥；不要新增原句里没有的信息、因果、评价或例子。"
        "输出结构："
        '{"entry":[{"action":"rename","suggested_word":"...","confidence":0.82,"reason":"..."},'
        '{"action":"split","confidence":0.82,"reason":"...","suggested_entries":[{"word":"...","definitions":["中文释义"],"focus_words":["..."],"example_indices":[0],"reason":"..."}]}],'
        '"definitions":[{"action":"replace|append|drop|replace_all","index":0,"reason":"...","suggested":"...","suggested_definitions":["..."]}],'
        '"examples":[{"index":0,"action":"keep|trim|drop|rewrite","reason":"...","suggested_text":"...","suggested_explanation":"..."}],'
        '"global_notes":["..."]}'
        "Entry 规则：rename 只用于把当前词条收敛为一个更准确的 headword；split 只用于当前词条确实包含多个独立学习点。"
        "split 的 suggested_entries 每个 definitions 必须是中文学习释义；example_indices 指可复用的原例句下标。"
        "Definitions 规则：replace 仅修改 index 对应释义；append 追加一条新释义；drop 删除 index；"
        "只有当整组 definitions 都应该重写时才使用 replace_all，并填写 suggested_definitions 数组。"
        "当 definitions: [] 时，不要返回空 definitions 建议，至少返回一个 append 或 replace_all。"
        "下面的规则预检只作为诊断线索，不是最终建议；你必须结合词条和例句独立判断。"
        "如果规则预检指出 definitions 为空，且词条是有效学习点，必须在 definitions 里返回 append 或 replace_all。"
        "如果规则预检指出重复、空值、focus 错位或 explanation 缺失，请把有价值的部分转化为对应 definitions/examples 建议；无价值则忽略。"
        f"词条: {word}\n"
        f"definitions: {json.dumps(definitions, ensure_ascii=False)}\n"
        f"examples: {json.dumps(examples, ensure_ascii=False)}\n"
        f"规则预检: {json.dumps(rule_context, ensure_ascii=False)}"
    )

    result = _call_llm_json(prompt, request_tag="file_cleaning")
    return _normalize_file_cleaning_result(result)
