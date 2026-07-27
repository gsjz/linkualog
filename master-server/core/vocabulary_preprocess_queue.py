from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock, Timeout

from core.data_paths import get_vocabulary_dir
import core.review_vocabulary as review_vocabulary


ACTIVE_STATUSES = {"queued", "running"}
FINISHED_STATUSES = {"success", "error", "skipped"}
MAX_FINISHED_ITEMS = 300

_lock = threading.RLock()
_items: dict[str, dict] = {}
_job_items: dict[str, list[str]] = {}


class VocabularyPreprocessBusyError(RuntimeError):
    def __init__(self, busy_items: list[dict]):
        self.busy_items = busy_items
        first = busy_items[0] if busy_items else {}
        label = str(first.get("label") or first.get("id") or "词条")
        stage_label = str(first.get("stage_label") or first.get("status_label") or "预处理中")
        super().__init__(f"{label} 正在{stage_label}，请等待后台预处理完成后再修改。")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_filename(filename: str) -> str:
    name = str(filename or "").strip()
    if not name:
        return ""
    if not name.endswith(".json"):
        name = f"{name}.json"
    return os.path.basename(name)


def entry_id(category: str, filename: str) -> str:
    normalized_category = str(category or "").strip()
    normalized_file = _normalize_filename(filename)
    return f"{normalized_category}/{normalized_file}" if normalized_category and normalized_file else ""


def _entry_label(category: str, filename: str) -> str:
    return f"{str(category or '').strip()} / {_normalize_filename(filename)}"


def _stage_label(stage: str) -> str:
    labels = {
        "queued": "等待预处理",
        "refine": "生成编辑建议",
        "relations": "生成连边建议",
        "finalizing": "收尾",
        "success": "已完成",
        "error": "失败",
        "skipped": "已跳过",
    }
    return labels.get(str(stage or "").strip(), str(stage or "").strip() or "预处理中")


def _public_item(item: dict) -> dict:
    return dict(item)


def _prune_finished_locked() -> None:
    finished = [
        (str(item.get("finished_at") or item.get("updated_at") or item.get("queued_at") or ""), item_id)
        for item_id, item in _items.items()
        if item.get("status") in FINISHED_STATUSES
    ]
    if len(finished) <= MAX_FINISHED_ITEMS:
        return

    finished.sort()
    for _, item_id in finished[: len(finished) - MAX_FINISHED_ITEMS]:
        item = _items.pop(item_id, None)
        job_id = str(item.get("job_id") or "") if isinstance(item, dict) else ""
        if job_id and job_id in _job_items:
            _job_items[job_id] = [current_id for current_id in _job_items[job_id] if current_id != item_id]
            if not _job_items[job_id]:
                _job_items.pop(job_id, None)


def register_preprocess_job(job_id: str, category: str, filenames: list[str]) -> list[dict]:
    normalized_job_id = str(job_id or "").strip()
    normalized_category = str(category or "").strip()
    queued_at = _now_iso()
    registered: list[dict] = []

    with _lock:
        job_entry_ids = []
        for index, filename in enumerate(filenames, start=1):
            normalized_file = _normalize_filename(filename)
            current_id = entry_id(normalized_category, normalized_file)
            if not current_id:
                continue
            existing = _items.get(current_id)
            if isinstance(existing, dict) and existing.get("status") in ACTIVE_STATUSES:
                registered.append(_public_item(existing))
                job_entry_ids.append(current_id)
                continue

            item = {
                "id": current_id,
                "category": normalized_category,
                "file": normalized_file,
                "job_id": normalized_job_id,
                "index": index,
                "total": len(filenames),
                "status": "queued",
                "status_label": "等待",
                "stage": "queued",
                "stage_label": _stage_label("queued"),
                "locked": False,
                "label": _entry_label(normalized_category, normalized_file),
                "queued_at": queued_at,
                "started_at": None,
                "finished_at": None,
                "updated_at": queued_at,
                "error": None,
                "summary": {},
            }
            _items[current_id] = item
            registered.append(_public_item(item))
            job_entry_ids.append(current_id)

        if normalized_job_id:
            _job_items[normalized_job_id] = job_entry_ids
        _prune_finished_locked()
    return registered


def set_preprocess_stage(
    job_id: str,
    category: str,
    filename: str,
    *,
    stage: str,
    status: str = "running",
    summary: dict | None = None,
    error: str | None = None,
    locked: bool | None = None,
) -> dict | None:
    current_id = entry_id(category, filename)
    if not current_id:
        return None

    now = _now_iso()
    with _lock:
        item = _items.get(current_id)
        if not isinstance(item, dict):
            register_preprocess_job(job_id, category, [filename])
            item = _items.get(current_id)
            if not isinstance(item, dict):
                return None
        item["job_id"] = str(job_id or item.get("job_id") or "")
        item["status"] = str(status or "running")
        item["status_label"] = "运行中" if item["status"] == "running" else _stage_label(item["status"])
        item["stage"] = str(stage or item.get("stage") or "")
        item["stage_label"] = _stage_label(item["stage"] or item["status"])
        if locked is not None:
            item["locked"] = bool(locked)
        if item["status"] == "running" and not item.get("started_at"):
            item["started_at"] = now
        if item["status"] in FINISHED_STATUSES:
            item["finished_at"] = now
            item["locked"] = False
        if isinstance(summary, dict):
            item["summary"] = summary
        if error:
            item["error"] = str(error)
        elif item["status"] != "error":
            item["error"] = None
        item["updated_at"] = now
        return _public_item(item)


def finish_preprocess_item(
    job_id: str,
    category: str,
    filename: str,
    *,
    status: str,
    summary: dict | None = None,
    error: str | None = None,
) -> dict | None:
    final_status = status if status in FINISHED_STATUSES else "success"
    return set_preprocess_stage(
        job_id,
        category,
        filename,
        stage=final_status,
        status=final_status,
        summary=summary,
        error=error,
        locked=False,
    )


def _preprocess_lock_path(category: str, filename: str) -> str:
    root = Path(review_vocabulary.VOCAB_DIR or get_vocabulary_dir()).resolve()
    safe_category = str(category or "").strip().replace(os.sep, "_") or "_"
    safe_file = _normalize_filename(filename).replace(os.sep, "_")
    lock_dir = root.parent / ".vocabulary_preprocess_locks" / safe_category
    lock_dir.mkdir(parents=True, exist_ok=True)
    return str(lock_dir / f"{safe_file}.lock")


@contextmanager
def active_preprocess_entry(job_id: str, category: str, filename: str, *, timeout: int = 60):
    normalized_file = _normalize_filename(filename)
    lock = FileLock(_preprocess_lock_path(category, normalized_file), timeout=timeout)
    set_preprocess_stage(job_id, category, normalized_file, stage="queued", status="queued", locked=False)
    try:
        with lock:
            set_preprocess_stage(job_id, category, normalized_file, stage="refine", status="running", locked=True)
            yield
    except Exception:
        raise
    finally:
        current_id = entry_id(category, normalized_file)
        with _lock:
            item = _items.get(current_id)
            if isinstance(item, dict) and item.get("status") in ACTIVE_STATUSES:
                item["locked"] = False
                item["updated_at"] = _now_iso()


def get_preprocess_queue(*, include_finished: bool = True, limit: int = 80) -> dict:
    normalized_limit = min(max(int(limit or 80), 1), 300)
    with _lock:
        values = [
            _public_item(item)
            for item in _items.values()
            if include_finished or item.get("status") in ACTIVE_STATUSES
        ]

    values.sort(
        key=lambda item: (
            0 if item.get("status") in ACTIVE_STATUSES else 1,
            str(item.get("queued_at") or ""),
            int(item.get("index") or 0),
            str(item.get("id") or ""),
        )
    )
    limited = values[:normalized_limit]
    return {
        "status": "success",
        "items": limited,
        "active": [item for item in limited if item.get("status") in ACTIVE_STATUSES],
        "active_count": sum(1 for item in values if item.get("status") in ACTIVE_STATUSES),
        "total": len(values),
    }


def _normalize_entry_specs(entries: list[tuple[str, str] | dict]) -> list[tuple[str, str]]:
    normalized: list[tuple[str, str]] = []
    seen = set()
    for entry in entries or []:
        if isinstance(entry, dict):
            category = str(entry.get("category") or "").strip()
            filename = _normalize_filename(entry.get("file") or entry.get("filename") or "")
        else:
            try:
                category, filename = entry
            except (TypeError, ValueError):
                continue
            category = str(category or "").strip()
            filename = _normalize_filename(filename)
        current_id = entry_id(category, filename)
        if not current_id or current_id in seen:
            continue
        seen.add(current_id)
        normalized.append((category, filename))
    normalized.sort(key=lambda item: entry_id(item[0], item[1]))
    return normalized


@contextmanager
def vocabulary_preprocess_write_lock(entries: list[tuple[str, str] | dict]):
    normalized_entries = _normalize_entry_specs(entries)
    locks: list[FileLock] = []

    with _lock:
        busy_items = [
            _public_item(_items[current_id])
            for category, filename in normalized_entries
            for current_id in [entry_id(category, filename)]
            if isinstance(_items.get(current_id), dict)
            and _items[current_id].get("status") in ACTIVE_STATUSES
        ]
    if busy_items:
        raise VocabularyPreprocessBusyError(busy_items)

    try:
        for category, filename in normalized_entries:
            lock = FileLock(_preprocess_lock_path(category, filename), timeout=0)
            try:
                lock.acquire(timeout=0)
            except Timeout as exc:
                raise VocabularyPreprocessBusyError([
                    {
                        "id": entry_id(category, filename),
                        "category": category,
                        "file": filename,
                        "label": _entry_label(category, filename),
                        "stage": "running",
                        "stage_label": "预处理",
                        "status": "running",
                    }
                ]) from exc
            locks.append(lock)
        yield
    finally:
        for lock in reversed(locks):
            try:
                lock.release()
            except Exception:
                pass


def reset_preprocess_queue_for_tests() -> None:
    with _lock:
        _items.clear()
        _job_items.clear()
