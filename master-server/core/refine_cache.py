from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock

from core.config import APP_DIR, get_config_data


CACHE_SCHEMA_VERSION = 1
FILE_REFINE_PROMPT_VERSION = 3
RELATION_SUGGEST_PROMPT_VERSION = 1
DEFAULT_CACHE_DIR = APP_DIR / "local_data/refine_cache"
REFINE_CACHE_DIR = Path(os.environ.get("REFINE_CACHE_DIR", DEFAULT_CACHE_DIR))


def _stable_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _cache_root() -> Path:
    root = Path(REFINE_CACHE_DIR)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _normalize_category(value: str) -> str:
    return str(value or "").strip()


def _normalize_filename(value: str) -> str:
    filename = os.path.basename(str(value or "").strip())
    if not filename:
        return ""
    return filename if filename.endswith(".json") else f"{filename}.json"


def _compact_extra_value(value):
    if isinstance(value, dict):
        compact = {
            str(key): _compact_extra_value(item)
            for key, item in value.items()
            if str(key).strip()
        }
        return {
            key: item
            for key, item in compact.items()
            if item not in ("", [], {}, None, False)
        }
    if isinstance(value, list):
        return [
            item
            for item in (_compact_extra_value(item) for item in value)
            if item not in ("", [], {}, None, False)
        ]
    if isinstance(value, str):
        return value
    return value


def _normalize_analysis_examples(raw_examples) -> list:
    if not isinstance(raw_examples, list):
        return []

    normalized = []
    for raw_example in raw_examples:
        if not isinstance(raw_example, dict):
            normalized.append(raw_example)
            continue

        entry = {
            "text": str(raw_example.get("text", "")),
            "explanation": str(raw_example.get("explanation", "")),
        }

        focus_words = raw_example.get("focusWords")
        if isinstance(focus_words, list):
            cleaned_focus_words = [
                str(word).strip()
                for word in focus_words
                if str(word).strip()
            ]
            if cleaned_focus_words:
                entry["focusWords"] = cleaned_focus_words

        focus_positions = raw_example.get(
            "focusPositions",
            raw_example.get("focusPosition", raw_example.get("fp", raw_example.get("fps"))),
        )
        if isinstance(focus_positions, list) and focus_positions:
            entry["focusPositions"] = focus_positions

        for key, value in raw_example.items():
            if key in {
                "text",
                "explanation",
                "focusWords",
                "focusPositions",
                "focusPosition",
                "fp",
                "fps",
            }:
                continue
            compact_value = _compact_extra_value(value)
            if compact_value not in ("", [], {}, None, False):
                entry[key] = compact_value

        normalized.append(entry)

    return normalized


def build_refine_analysis_payload(file_name: str, payload: dict) -> dict:
    source = payload if isinstance(payload, dict) else {}
    return {
        "word": str(source.get("word") or Path(_normalize_filename(file_name)).stem).strip(),
        "definitions": source.get("definitions") if isinstance(source.get("definitions"), list) else [],
        "examples": _normalize_analysis_examples(source.get("examples")),
    }


def _normalize_relation_cache_items(raw_relations) -> list[dict]:
    if not isinstance(raw_relations, list):
        return []

    normalized = []
    for raw_relation in raw_relations:
        if not isinstance(raw_relation, dict):
            continue
        raw_target = raw_relation.get("target") if isinstance(raw_relation.get("target"), dict) else {}
        target_file = _normalize_filename(raw_target.get("file") or raw_target.get("filename"))
        target_category = _normalize_category(raw_target.get("category"))
        target_word = str(raw_target.get("word") or Path(target_file).stem).strip()
        if not target_file:
            continue
        normalized.append(
            {
                "type": str(raw_relation.get("type") or "related").strip().lower() or "related",
                "target": {
                    "category": target_category,
                    "file": target_file,
                    "word": target_word,
                },
            }
        )

    normalized.sort(
        key=lambda item: (
            item["target"]["category"],
            item["target"]["file"].lower(),
            item["type"],
        )
    )
    return normalized


def build_relation_suggest_analysis_payload(file_name: str, payload: dict) -> dict:
    source = payload if isinstance(payload, dict) else {}
    return {
        "word": str(source.get("word") or Path(_normalize_filename(file_name)).stem).strip(),
        "definitions": source.get("definitions") if isinstance(source.get("definitions"), list) else [],
        "examples": _normalize_analysis_examples(source.get("examples")),
        "relations": _normalize_relation_cache_items(source.get("relations")),
    }


def payload_fingerprint(payload: dict) -> str:
    return hashlib.sha256(_stable_json(payload if isinstance(payload, dict) else {}).encode("utf-8")).hexdigest()


def llm_config_fingerprint() -> str:
    config = get_config_data()
    relevant = {
        "provider": config.get("provider", ""),
        "model": config.get("model", ""),
        "review_llm_timeout_seconds": config.get("review_llm_timeout_seconds", ""),
        "review_llm_request_max_retries": config.get("review_llm_request_max_retries", ""),
    }
    return hashlib.sha256(_stable_json(relevant).encode("utf-8")).hexdigest()


def build_refine_cache_key(category: str, filename: str, payload: dict) -> dict:
    normalized_category = _normalize_category(category)
    normalized_filename = _normalize_filename(filename)
    analysis_payload = build_refine_analysis_payload(normalized_filename, payload)
    content_hash = payload_fingerprint(analysis_payload)
    config_hash = llm_config_fingerprint()
    raw_key = _stable_json(
        {
            "schema": CACHE_SCHEMA_VERSION,
            "kind": "file_refine_llm",
            "prompt_version": FILE_REFINE_PROMPT_VERSION,
            "category": normalized_category,
            "filename": normalized_filename,
            "content_hash": content_hash,
            "config_hash": config_hash,
        }
    )
    return {
        "schema": CACHE_SCHEMA_VERSION,
        "kind": "file_refine_llm",
        "prompt_version": FILE_REFINE_PROMPT_VERSION,
        "category": normalized_category,
        "filename": normalized_filename,
        "content_hash": content_hash,
        "config_hash": config_hash,
        "cache_key": hashlib.sha256(raw_key.encode("utf-8")).hexdigest(),
    }


def build_relation_suggest_cache_key(
    category: str,
    filename: str,
    payload: dict,
    *,
    limit: int = 12,
    candidate_limit: int = 72,
) -> dict:
    normalized_category = _normalize_category(category)
    normalized_filename = _normalize_filename(filename)
    normalized_limit = max(1, min(int(limit or 12), 30))
    normalized_candidate_limit = max(12, min(int(candidate_limit or 72), 180))
    analysis_payload = build_relation_suggest_analysis_payload(normalized_filename, payload)
    content_hash = payload_fingerprint(analysis_payload)
    config_hash = llm_config_fingerprint()
    raw_key = _stable_json(
        {
            "schema": CACHE_SCHEMA_VERSION,
            "kind": "relation_suggest_llm",
            "prompt_version": RELATION_SUGGEST_PROMPT_VERSION,
            "category": normalized_category,
            "filename": normalized_filename,
            "limit": normalized_limit,
            "candidate_limit": normalized_candidate_limit,
            "content_hash": content_hash,
            "config_hash": config_hash,
        }
    )
    return {
        "schema": CACHE_SCHEMA_VERSION,
        "kind": "relation_suggest_llm",
        "prompt_version": RELATION_SUGGEST_PROMPT_VERSION,
        "category": normalized_category,
        "filename": normalized_filename,
        "limit": normalized_limit,
        "candidate_limit": normalized_candidate_limit,
        "content_hash": content_hash,
        "config_hash": config_hash,
        "cache_key": hashlib.sha256(raw_key.encode("utf-8")).hexdigest(),
    }


def _cache_path(cache_key: str) -> Path:
    safe_key = "".join(ch for ch in str(cache_key or "") if ch.isalnum() or ch in {"-", "_"})
    if not safe_key:
        raise ValueError("cache_key 不能为空")
    return _cache_root() / f"{safe_key}.json"


def load_refine_cache(cache_meta: dict) -> dict | None:
    cache_key = str(cache_meta.get("cache_key") or "")
    path = _cache_path(cache_key)
    if not path.exists():
        return None

    with FileLock(f"{path}.lock", timeout=3):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    if not isinstance(data, dict):
        return None
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    if meta.get("schema") != CACHE_SCHEMA_VERSION:
        return None
    if meta.get("cache_key") != cache_key:
        return None
    if meta.get("content_hash") != cache_meta.get("content_hash"):
        return None
    if meta.get("config_hash") != cache_meta.get("config_hash"):
        return None
    return data


def has_refine_cache_for_entry(category: str, filename: str, payload: dict) -> bool:
    cache_meta = build_refine_cache_key(category, filename, payload)
    cached = load_refine_cache(cache_meta)
    if not isinstance(cached, dict):
        return False
    if cached.get("llm_error"):
        return False
    llm = cached.get("llm")
    if not isinstance(llm, dict):
        return False
    return any(
        isinstance(llm.get(key), list) and len(llm.get(key)) > 0
        for key in ("entry", "definitions", "examples")
    )


def has_relation_suggest_cache_for_entry(
    category: str,
    filename: str,
    payload: dict,
    *,
    limit: int = 12,
    candidate_limit: int = 72,
) -> bool:
    cache_meta = build_relation_suggest_cache_key(
        category,
        filename,
        payload,
        limit=limit,
        candidate_limit=candidate_limit,
    )
    cached = load_refine_cache(cache_meta)
    if not isinstance(cached, dict):
        return False
    if cached.get("llm_error"):
        return False
    response = cached.get("llm")
    if not isinstance(response, dict):
        return False
    suggestions = response.get("suggestions")
    if isinstance(suggestions, list):
        return len(suggestions) > 0
    llm = response.get("llm") if isinstance(response.get("llm"), dict) else {}
    llm_suggestions = llm.get("suggestions")
    return isinstance(llm_suggestions, list) and len(llm_suggestions) > 0


def save_refine_cache(cache_meta: dict, llm: dict | None, llm_error: str | None = None) -> dict:
    cache_key = str(cache_meta.get("cache_key") or "")
    path = _cache_path(cache_key)
    created_at = datetime.now(timezone.utc).isoformat()
    data = {
        "meta": {
            **cache_meta,
            "schema": CACHE_SCHEMA_VERSION,
            "created_at": created_at,
        },
        "llm": llm,
        "llm_error": str(llm_error or "") or None,
    }

    with FileLock(f"{path}.lock", timeout=5):
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def delete_refine_cache_for_entry(category: str, filename: str) -> int:
    normalized_category = _normalize_category(category)
    normalized_filename = _normalize_filename(filename)
    deleted = 0
    root = _cache_root()
    for path in root.glob("*.json"):
        try:
            with FileLock(f"{path}.lock", timeout=1):
                data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        meta = data.get("meta") if isinstance(data, dict) else {}
        if (
            meta.get("category") == normalized_category
            and meta.get("filename") == normalized_filename
        ):
            try:
                path.unlink()
                deleted += 1
            except FileNotFoundError:
                pass
    return deleted
