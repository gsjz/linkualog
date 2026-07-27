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


def load_redirects() -> dict:
    path = _redirects_path()
    with FileLock(f"{path}.lock", timeout=5):
        return _read_index_locked(path)


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
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
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
