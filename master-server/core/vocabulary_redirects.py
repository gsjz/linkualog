from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock

from core.data_paths import get_vocabulary_dir
import core.review_vocabulary as review_vocabulary


MAX_REDIRECT_DEPTH = 12
REDIRECTS_FILENAME = ".vocabulary_redirects.json"
_RELATION_KEYS = (
    "relations",
    "graphEdges",
    "graph_edges",
    "edges",
    "links",
    "related",
    "seeAlso",
    "see_also",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_filename(filename: str) -> str:
    name = os.path.basename(str(filename or "").strip())
    if not name:
        return ""
    return name if name.endswith(".json") else f"{name}.json"


def entry_id(category: str, filename: str) -> str:
    normalized_category = str(category or "").strip()
    normalized_file = _normalize_filename(filename)
    return f"{normalized_category}/{normalized_file}" if normalized_category and normalized_file else ""


def _redirects_path() -> Path:
    root = Path(review_vocabulary.VOCAB_DIR or get_vocabulary_dir()).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root / REDIRECTS_FILENAME


def _read_index_locked(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    redirects = data.get("redirects") if isinstance(data.get("redirects"), dict) else {}
    return {"redirects": redirects}


def _write_index_locked(path: Path, data: dict) -> None:
    redirects = data.get("redirects") if isinstance(data.get("redirects"), dict) else {}
    if redirects:
        path.write_text(json.dumps({"redirects": redirects}, ensure_ascii=False, indent=2), encoding="utf-8")
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _value_relation_ref_ids(value, default_category: str = "") -> set[str]:
    found: set[str] = set()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return found
        if "/" in raw:
            category_part, file_part = raw.rsplit("/", 1)
            current_id = entry_id(category_part or default_category, file_part)
            if current_id:
                found.add(current_id)
        elif raw.endswith(".json"):
            current_id = entry_id(default_category, raw)
            if current_id:
                found.add(current_id)
        return found

    if isinstance(value, list):
        for item in value:
            found.update(_value_relation_ref_ids(item, default_category))
        return found

    if not isinstance(value, dict):
        return found

    category = str(
        value.get("category")
        or value.get("target_category")
        or value.get("targetCategory")
        or default_category
    ).strip()
    filename = _normalize_filename(
        value.get("file")
        or value.get("filename")
        or value.get("target_file")
        or value.get("targetFile")
        or ""
    )
    current_id = entry_id(category, filename)
    if current_id:
        found.add(current_id)

    nested_default_category = category or default_category
    for item in value.values():
        found.update(_value_relation_ref_ids(item, nested_default_category))
    return found


def _payload_references_entry(payload: dict, default_category: str, target_id: str) -> bool:
    if not isinstance(payload, dict) or not target_id:
        return False
    for key in _RELATION_KEYS:
        if key not in payload:
            continue
        if target_id in _value_relation_ref_ids(payload.get(key), default_category):
            return True
    return False


def _redirect_source_is_referenced(source_id: str) -> bool:
    if not source_id:
        return False
    for category_name in review_vocabulary.list_categories():
        try:
            files = review_vocabulary.list_vocab_files(category_name)
        except Exception:
            continue
        for path in files:
            try:
                payload = review_vocabulary.load_vocab_file(path)
            except Exception:
                continue
            if _payload_references_entry(payload, category_name, source_id):
                return True
    return False


def load_redirects() -> dict:
    path = _redirects_path()
    with FileLock(f"{path}.lock", timeout=5):
        return _read_index_locked(path)


def prune_resolved_redirects(source_ids: set[str] | None = None) -> dict:
    path = _redirects_path()
    with FileLock(f"{path}.lock", timeout=5):
        data = _read_index_locked(path)
        redirects = data["redirects"]
        scoped_source_ids = {str(item or "").strip() for item in source_ids or set() if str(item or "").strip()}
        removed: list[str] = []
        for source_id in list(redirects.keys()):
            if scoped_source_ids and source_id not in scoped_source_ids:
                continue
            if _redirect_source_is_referenced(source_id):
                continue
            redirects.pop(source_id, None)
            removed.append(source_id)
        if removed:
            _write_index_locked(path, data)
        return {
            "removed": removed,
            "removed_count": len(removed),
            "remaining_count": len(redirects),
        }


def save_redirect(
    *,
    source_category: str,
    source_filename: str,
    source_word: str = "",
    target_category: str,
    target_filename: str,
    target_word: str = "",
    reason: str = "",
) -> dict:
    source_id = entry_id(source_category, source_filename)
    target_id = entry_id(target_category, target_filename)
    if not source_id or not target_id or source_id == target_id:
        return {}

    path = _redirects_path()
    with FileLock(f"{path}.lock", timeout=5):
        data = _read_index_locked(path)
        redirects = data["redirects"]
        record = {
            "status": "merged",
            "from": {
                "category": str(source_category or "").strip(),
                "file": _normalize_filename(source_filename),
                "word": str(source_word or "").strip(),
            },
            "to": {
                "category": str(target_category or "").strip(),
                "file": _normalize_filename(target_filename),
                "word": str(target_word or "").strip(),
            },
            "reason": str(reason or "").strip() or "merge",
            "created_at": _now_iso(),
        }
        redirects[source_id] = record
        _write_index_locked(path, data)
    return record


def resolve_redirect(category: str, filename: str) -> dict:
    original_id = entry_id(category, filename)
    if not original_id:
        return {
            "status": "invalid",
            "original_id": "",
            "resolved": None,
            "chain": [],
        }

    redirects = load_redirects().get("redirects", {})
    current_id = original_id
    chain = []
    seen = set()
    for _ in range(MAX_REDIRECT_DEPTH):
        if current_id in seen:
            return {
                "status": "cycle",
                "original_id": original_id,
                "resolved": None,
                "chain": chain,
            }
        seen.add(current_id)
        record = redirects.get(current_id)
        if not isinstance(record, dict):
            break
        chain.append(record)
        target = record.get("to") if isinstance(record.get("to"), dict) else {}
        next_id = entry_id(str(target.get("category") or ""), str(target.get("file") or ""))
        if not next_id:
            return {
                "status": "missing",
                "original_id": original_id,
                "resolved": None,
                "chain": chain,
            }
        current_id = next_id
    else:
        return {
            "status": "too_deep",
            "original_id": original_id,
            "resolved": None,
            "chain": chain,
        }

    if current_id == original_id:
        normalized_file = _normalize_filename(filename)
        return {
            "status": "current",
            "original_id": original_id,
            "resolved": {
                "category": str(category or "").strip(),
                "file": normalized_file,
                "word": Path(normalized_file).stem,
            },
            "chain": [],
        }

    target_category, target_file = current_id.split("/", 1)
    last_target = chain[-1].get("to") if chain and isinstance(chain[-1].get("to"), dict) else {}
    return {
        "status": "redirected",
        "original_id": original_id,
        "resolved": {
            "category": target_category,
            "file": target_file,
            "word": str(last_target.get("word") or Path(target_file).stem).strip(),
        },
        "chain": chain,
    }


def reset_redirects_for_tests() -> None:
    path = _redirects_path()
    for suffix in ("", ".lock"):
        try:
            Path(f"{path}{suffix}").unlink()
        except FileNotFoundError:
            pass
