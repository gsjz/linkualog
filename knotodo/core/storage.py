import json
import logging
import os
import shutil
from collections import defaultdict
from contextlib import suppress
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from filelock import FileLock

WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
BLOCK_COLOR_KEYS = ("slate", "teal", "gold", "coral")
EVENT_TYPE_KEYS = ("interval", "recurring", "floating", "deadline")
REPEAT_RULE_KEYS = ("none", "daily", "weekly")
CARD_EVENT_TYPE_KEYS = ("none", "interval", "recurring", "deadline")

DB_FILE = os.environ.get("KNOTODO_DB_FILE", str(Path(__file__).resolve().parents[1] / "local_data" / "state.json"))
LOCK_FILE = os.environ.get("KNOTODO_LOCK_FILE", f"{DB_FILE}.lock")
BACKUP_FILE = os.environ.get(
    "KNOTODO_DB_BACKUP_FILE",
    str(Path(DB_FILE).with_name(f"{Path(DB_FILE).stem}.backup{Path(DB_FILE).suffix}")),
)
LOCK_TIMEOUT_SECONDS = float(os.environ.get("KNOTODO_LOCK_TIMEOUT", "10"))

logger = logging.getLogger(__name__)


def _empty_state() -> dict:
    return {
        "todos": [],
        "events": [],
        "templates": [],
        "boards": [],
        "lanes": [],
        "cards": [],
    }


def _ensure_parent() -> None:
    Path(DB_FILE).parent.mkdir(parents=True, exist_ok=True)
    Path(BACKUP_FILE).parent.mkdir(parents=True, exist_ok=True)


def _normalize_date(value: str | None, fallback: str | None = None) -> str:
    candidate = str(value or fallback or date.today().isoformat()).strip()
    return date.fromisoformat(candidate).isoformat()


def _normalize_optional_date(value: str | None) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    return date.fromisoformat(candidate).isoformat()


def _normalize_time(value: str | None) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    return datetime.strptime(candidate, "%H:%M").strftime("%H:%M")


def _normalize_weekdays(value) -> list[str]:
    if isinstance(value, str):
        raw_items = [part.strip().lower() for part in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        raw_items = [str(part).strip().lower() for part in value]
    else:
        raw_items = []

    unique_items: list[str] = []
    seen = set()
    for item in raw_items:
        if item not in WEEKDAY_KEYS or item in seen:
            continue
        seen.add(item)
        unique_items.append(item)

    return [item for item in WEEKDAY_KEYS if item in unique_items]


def _normalize_block_minutes(value, fallback: int = 45) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = int(fallback)

    normalized = max(15, min(180, normalized))
    remainder = normalized % 15
    if remainder:
        normalized -= remainder
    return max(15, normalized)


def _normalize_block_color(value: str | None, fallback: str = "slate") -> str:
    candidate = str(value or fallback or "slate").strip().lower()
    if candidate not in BLOCK_COLOR_KEYS:
        return "slate"
    return candidate


def _normalize_event_type(value: str | None) -> str:
    candidate = str(value or "interval").strip().lower()
    if candidate not in EVENT_TYPE_KEYS:
        return "interval"
    return candidate


def _normalize_repeat_rule(value: str | None) -> str:
    candidate = str(value or "none").strip().lower()
    if candidate not in REPEAT_RULE_KEYS:
        return "none"
    return candidate


def _normalize_position(value, fallback: int = 1024) -> int:
    try:
        position = int(value)
    except (TypeError, ValueError):
        position = int(fallback)
    return max(1, position)


def _normalize_short_list(value, max_items: int = 8, max_length: int = 24) -> list[str]:
    if isinstance(value, str):
        raw_items = [part.strip() for part in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        raw_items = [str(part).strip() for part in value]
    else:
        raw_items = []

    normalized: list[str] = []
    seen = set()
    for item in raw_items:
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(item[:max_length])
        if len(normalized) >= max_items:
            break
    return normalized


def _normalize_checklist(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    normalized: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        normalized.append({
            "id": str(item.get("id") or uuid4()),
            "text": text[:120],
            "done": bool(item.get("done", False)),
        })
    return normalized[:40]


def _sort_key(item: dict) -> tuple:
    return (
        item.get("date") or "9999-12-31",
        item.get("start_time", "99:99"),
        item.get("due_time", "99:99"),
        item.get("title", "").lower(),
    )


def _board_sort_key(item: dict) -> tuple:
    return (
        item.get("updated_at", ""),
        item.get("created_at", ""),
        item.get("title", "").lower(),
        item.get("id", ""),
    )


def _lane_sort_key(item: dict) -> tuple:
    return (
        item.get("board_id", ""),
        _normalize_position(item.get("position"), 1024),
        item.get("created_at", ""),
        item.get("id", ""),
    )


def _card_sort_key(item: dict) -> tuple:
    return (
        item.get("board_id", ""),
        item.get("lane_id", ""),
        1 if bool(item.get("archived", False)) else 0,
        _normalize_position(item.get("position"), 1024),
        item.get("updated_at", ""),
        item.get("id", ""),
    )


def _template_sort_key(item: dict) -> tuple:
    return (
        item.get("updated_at", ""),
        item.get("created_at", ""),
        item.get("title", "").lower(),
        item.get("id", ""),
    )


def _normalize_todo(item: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    normalized = {
        "id": str(item.get("id") or uuid4()),
        "title": str(item.get("title") or "").strip(),
        "notes": str(item.get("notes") or "").strip(),
        "date": _normalize_date(item.get("date")),
        "due_time": _normalize_time(item.get("due_time")),
        "source_template_id": str(item.get("source_template_id") or "").strip(),
        "preferred_block_minutes": _normalize_block_minutes(item.get("preferred_block_minutes"), 45),
        "preferred_block_color": _normalize_block_color(item.get("preferred_block_color"), "slate"),
        "priority": str(item.get("priority") or "medium").strip().lower(),
        "completed": bool(item.get("completed", False)),
        "created_at": str(item.get("created_at") or now),
        "updated_at": str(item.get("updated_at") or now),
    }
    if normalized["priority"] not in {"low", "medium", "high"}:
        normalized["priority"] = "medium"
    return normalized


def _normalize_event(item: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    event_type = _normalize_event_type(item.get("event_type"))
    repeat_rule = _normalize_repeat_rule(item.get("repeat_rule"))
    repeat_weekdays = _normalize_weekdays(item.get("repeat_weekdays"))
    normalized_date = _normalize_optional_date(item.get("date"))
    start_time = _normalize_time(item.get("start_time"))
    end_time = _normalize_time(item.get("end_time"))

    if event_type in {"interval", "deadline"} and not normalized_date:
        normalized_date = _normalize_date(None)
    if event_type == "floating":
        normalized_date = ""
        start_time = ""
        end_time = ""
        repeat_rule = "none"
        repeat_weekdays = []
    elif event_type == "recurring":
        if repeat_rule not in {"daily", "weekly"}:
            repeat_rule = "weekly"
        if repeat_rule == "weekly" and not repeat_weekdays and normalized_date:
            weekday = WEEKDAY_KEYS[date.fromisoformat(normalized_date).weekday()]
            repeat_weekdays = [weekday]
    else:
        repeat_rule = "none"
        repeat_weekdays = []

    normalized = {
        "id": str(item.get("id") or uuid4()),
        "title": str(item.get("title") or "").strip(),
        "date": normalized_date,
        "start_time": start_time,
        "end_time": end_time,
        "color": str(item.get("color") or "teal").strip().lower(),
        "notes": str(item.get("notes") or "").strip(),
        "source_todo_id": str(item.get("source_todo_id") or "").strip(),
        "event_type": event_type,
        "repeat_rule": repeat_rule,
        "repeat_weekdays": repeat_weekdays,
        "created_at": str(item.get("created_at") or now),
        "updated_at": str(item.get("updated_at") or now),
    }
    if normalized["color"] not in {"teal", "coral", "gold", "slate"}:
        normalized["color"] = "teal"
    return normalized


def _normalize_template(item: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    normalized = {
        "id": str(item.get("id") or uuid4()),
        "title": str(item.get("title") or "").strip(),
        "notes": str(item.get("notes") or "").strip(),
        "due_time": _normalize_time(item.get("due_time")),
        "priority": str(item.get("priority") or "medium").strip().lower(),
        "weekdays": _normalize_weekdays(item.get("weekdays")),
        "default_block_minutes": _normalize_block_minutes(item.get("default_block_minutes"), 45),
        "default_block_color": _normalize_block_color(item.get("default_block_color"), "slate"),
        "created_at": str(item.get("created_at") or now),
        "updated_at": str(item.get("updated_at") or now),
    }
    if normalized["priority"] not in {"low", "medium", "high"}:
        normalized["priority"] = "medium"
    return normalized


def _normalize_board(item: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    normalized = {
        "id": str(item.get("id") or uuid4()),
        "title": str(item.get("title") or "").strip()[:120],
        "description": str(item.get("description") or "").strip()[:2000],
        "color": _normalize_block_color(item.get("color"), "slate"),
        "created_at": str(item.get("created_at") or now),
        "updated_at": str(item.get("updated_at") or now),
    }
    if not normalized["title"]:
        normalized["title"] = "Untitled Board"
    return normalized


def _normalize_lane(item: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    normalized = {
        "id": str(item.get("id") or uuid4()),
        "board_id": str(item.get("board_id") or "").strip(),
        "title": str(item.get("title") or "").strip()[:80],
        "position": _normalize_position(item.get("position"), 1024),
        "created_at": str(item.get("created_at") or now),
        "updated_at": str(item.get("updated_at") or now),
    }
    if not normalized["title"]:
        normalized["title"] = "Untitled List"
    return normalized


def _normalize_card(item: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    event_type = str(item.get("event_type") or "none").strip().lower()
    if event_type not in CARD_EVENT_TYPE_KEYS:
        event_type = "none"

    repeat_rule = _normalize_repeat_rule(item.get("repeat_rule"))
    repeat_weekdays = _normalize_weekdays(item.get("repeat_weekdays"))
    event_date = _normalize_optional_date(item.get("date"))
    repeat_end_date = _normalize_optional_date(item.get("repeat_end_date"))
    due_date = _normalize_optional_date(item.get("due_date"))
    start_time = _normalize_time(item.get("start_time"))
    end_time = _normalize_time(item.get("end_time"))

    if event_type == "none":
        event_date = ""
        repeat_end_date = ""
        start_time = ""
        end_time = ""
        repeat_rule = "none"
        repeat_weekdays = []
    elif event_type == "recurring":
        if not event_date and due_date:
            event_date = due_date
        if repeat_rule not in {"daily", "weekly"}:
            repeat_rule = "weekly"
        if repeat_rule == "weekly" and not repeat_weekdays and event_date:
            repeat_weekdays = [WEEKDAY_KEYS[date.fromisoformat(event_date).weekday()]]
        if repeat_end_date and event_date and repeat_end_date < event_date:
            repeat_end_date = event_date
        if not start_time or not end_time:
            start_time = start_time or "09:00"
            end_time = end_time or "10:00"
    elif event_type in {"interval", "deadline"}:
        repeat_end_date = ""
        if not event_date and due_date:
            event_date = due_date
        if event_type == "deadline":
            start_time = start_time or "18:00"
            if not end_time:
                end_time = _normalize_time(
                    (datetime.strptime(start_time, "%H:%M") + timedelta(minutes=30)).strftime("%H:%M"),
                )
        if event_type == "interval":
            if not start_time:
                start_time = "09:00"
            if not end_time:
                end_time = "10:00"
        repeat_rule = "none"
        repeat_weekdays = []

    archived = bool(item.get("archived", False))
    archived_at = str(item.get("archived_at") or "").strip()
    if archived and not archived_at:
        archived_at = now
    if not archived:
        archived_at = ""

    normalized = {
        "id": str(item.get("id") or uuid4()),
        "board_id": str(item.get("board_id") or "").strip(),
        "lane_id": str(item.get("lane_id") or "").strip(),
        "title": str(item.get("title") or "").strip()[:160],
        "description": str(item.get("description") or "").strip()[:4000],
        "labels": _normalize_short_list(item.get("labels"), max_items=10, max_length=24),
        "members": _normalize_short_list(item.get("members"), max_items=12, max_length=24),
        "checklist": _normalize_checklist(item.get("checklist")),
        "position": _normalize_position(item.get("position"), 1024),
        "due_date": due_date,
        "color": _normalize_block_color(item.get("color"), "slate"),
        "event_type": event_type,
        "date": event_date,
        "repeat_end_date": repeat_end_date,
        "start_time": start_time,
        "end_time": end_time,
        "repeat_rule": repeat_rule,
        "repeat_weekdays": repeat_weekdays,
        "archived": archived,
        "archived_at": archived_at,
        "created_at": str(item.get("created_at") or now),
        "updated_at": str(item.get("updated_at") or now),
    }
    if not normalized["title"]:
        normalized["title"] = "Untitled Card"
    return normalized


def _bootstrap_kanban(boards: list[dict], lanes: list[dict], cards: list[dict], todos: list[dict], events: list[dict]) -> tuple[list[dict], list[dict], list[dict], bool]:
    if boards:
        return boards, lanes, cards, False

    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    board_id = str(uuid4())
    todo_lane_id = str(uuid4())
    doing_lane_id = str(uuid4())
    done_lane_id = str(uuid4())

    boards = [_normalize_board({
        "id": board_id,
        "title": "My Board",
        "description": "Trello 风格看板主工作区",
        "color": "slate",
        "created_at": now,
        "updated_at": now,
    })]
    lanes = [
        _normalize_lane({"id": todo_lane_id, "board_id": board_id, "title": "To Do", "position": 1024, "created_at": now, "updated_at": now}),
        _normalize_lane({"id": doing_lane_id, "board_id": board_id, "title": "Doing", "position": 2048, "created_at": now, "updated_at": now}),
        _normalize_lane({"id": done_lane_id, "board_id": board_id, "title": "Done", "position": 3072, "created_at": now, "updated_at": now}),
    ]

    next_position = {todo_lane_id: 1024, doing_lane_id: 1024, done_lane_id: 1024}
    cards = []

    for todo in sorted(todos, key=_sort_key):
        lane_id = done_lane_id if todo.get("completed") else todo_lane_id
        event_type = "deadline" if todo.get("due_time") else "none"
        cards.append(_normalize_card({
            "board_id": board_id,
            "lane_id": lane_id,
            "title": todo.get("title", ""),
            "description": todo.get("notes", ""),
            "labels": [todo.get("priority", "medium")],
            "due_date": todo.get("date", ""),
            "event_type": event_type,
            "date": todo.get("date", ""),
            "start_time": todo.get("due_time", ""),
            "color": _normalize_block_color(todo.get("preferred_block_color"), "slate"),
            "position": next_position[lane_id],
            "created_at": todo.get("created_at", now),
            "updated_at": todo.get("updated_at", now),
        }))
        next_position[lane_id] += 1024

    for event in sorted(events, key=_sort_key):
        if event.get("event_type") == "floating":
            continue
        cards.append(_normalize_card({
            "board_id": board_id,
            "lane_id": doing_lane_id,
            "title": event.get("title", ""),
            "description": event.get("notes", ""),
            "due_date": event.get("date", ""),
            "event_type": event.get("event_type", "interval"),
            "date": event.get("date", ""),
            "start_time": event.get("start_time", ""),
            "end_time": event.get("end_time", ""),
            "repeat_rule": event.get("repeat_rule", "none"),
            "repeat_weekdays": event.get("repeat_weekdays", []),
            "color": event.get("color", "teal"),
            "position": next_position[doing_lane_id],
            "created_at": event.get("created_at", now),
            "updated_at": event.get("updated_at", now),
        }))
        next_position[doing_lane_id] += 1024

    return boards, lanes, cards, True


def _backfill_event_links(todos: list[dict], events: list[dict]) -> tuple[list[dict], bool]:
    precise_candidates: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    fallback_candidates: dict[tuple[str, str, str], list[str]] = defaultdict(list)

    for todo in todos:
        due_time = todo.get("due_time") or ""
        if not due_time:
            continue
        precise_candidates[(todo["date"], todo["title"], due_time, todo["notes"])].append(todo["id"])
        fallback_candidates[(todo["date"], todo["title"], due_time)].append(todo["id"])

    used_todo_ids = {str(item.get("source_todo_id") or "").strip() for item in events if item.get("source_todo_id")}
    next_events: list[dict] = []
    changed = False

    for event in events:
        if (
            event.get("event_type") in {"floating", "recurring"}
            or not event.get("date")
            or event.get("source_todo_id")
            or not event.get("start_time")
        ):
            next_events.append(event)
            continue

        precise_key = (event["date"], event["title"], event["start_time"], event["notes"])
        fallback_key = (event["date"], event["title"], event["start_time"])

        precise_matches = [item for item in precise_candidates.get(precise_key, []) if item not in used_todo_ids]
        fallback_matches = [item for item in fallback_candidates.get(fallback_key, []) if item not in used_todo_ids]

        linked_todo_id = ""
        if len(precise_matches) == 1:
            linked_todo_id = precise_matches[0]
        elif len(fallback_matches) == 1:
            linked_todo_id = fallback_matches[0]

        if not linked_todo_id:
            next_events.append(event)
            continue

        used_todo_ids.add(linked_todo_id)
        next_events.append({**event, "source_todo_id": linked_todo_id})
        changed = True

    return next_events, changed


def _normalize_state(raw: dict | None) -> tuple[dict, bool]:
    source = raw if isinstance(raw, dict) else _empty_state()
    todos = [_normalize_todo(item) for item in source.get("todos", []) if isinstance(item, dict)]
    events = [_normalize_event(item) for item in source.get("events", []) if isinstance(item, dict)]
    templates = [_normalize_template(item) for item in source.get("templates", []) if isinstance(item, dict)]
    boards = [_normalize_board(item) for item in source.get("boards", []) if isinstance(item, dict)]
    lanes = [_normalize_lane(item) for item in source.get("lanes", []) if isinstance(item, dict)]
    cards = [_normalize_card(item) for item in source.get("cards", []) if isinstance(item, dict)]

    events, changed = _backfill_event_links(todos, events)
    boards, lanes, cards, bootstrapped = _bootstrap_kanban(boards, lanes, cards, todos, events)

    board_ids = {item["id"] for item in boards}
    lanes = [item for item in lanes if item.get("board_id") in board_ids]
    lane_ids = {item["id"] for item in lanes}
    cards = [
        item
        for item in cards
        if item.get("board_id") in board_ids and item.get("lane_id") in lane_ids
    ]

    normalized = {
        "todos": sorted(todos, key=_sort_key),
        "events": sorted(events, key=_sort_key),
        "templates": sorted(templates, key=_template_sort_key, reverse=True),
        "boards": sorted(boards, key=_board_sort_key, reverse=True),
        "lanes": sorted(lanes, key=_lane_sort_key),
        "cards": sorted(cards, key=_card_sort_key),
    }
    return normalized, changed or bootstrapped or normalized != source


def _write_json_atomic(path: Path, payload: dict) -> None:
    temp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, path)
    finally:
        with suppress(FileNotFoundError):
            temp_path.unlink()


def _write_state_unlocked(state: dict) -> dict:
    normalized, _ = _normalize_state(state)
    _write_json_atomic(Path(DB_FILE), normalized)
    _write_json_atomic(Path(BACKUP_FILE), normalized)
    return normalized


def _backup_corrupted_db(db_path: Path) -> Path | None:
    if not db_path.exists():
        return None

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = db_path.with_name(f"{db_path.stem}.corrupt-{timestamp}{db_path.suffix}")
    try:
        shutil.copy2(db_path, target)
        return target
    except OSError:
        logger.exception("无法备份损坏的状态文件: %s", db_path)
        return None


def _load_backup_state_unlocked() -> dict | None:
    backup_path = Path(BACKUP_FILE)
    if not backup_path.exists():
        return None

    try:
        with open(backup_path, "r", encoding="utf-8") as file:
            raw = json.load(file)
    except (OSError, json.JSONDecodeError):
        logger.exception("读取状态备份失败: %s", backup_path)
        return None

    if not isinstance(raw, dict):
        return None
    return raw


def _restore_safe_state_unlocked(reason: str) -> dict:
    backup_state = _load_backup_state_unlocked()
    if backup_state is not None:
        try:
            normalized_backup, _ = _normalize_state(backup_state)
        except ValueError:
            logger.exception("状态备份存在非法字段，无法用于恢复。reason=%s", reason)
        else:
            logger.warning("状态文件异常，已从备份恢复。reason=%s", reason)
            return _write_state_unlocked(normalized_backup)

    logger.warning("状态文件异常且备份不可用，已回退为空状态。reason=%s", reason)
    return _write_state_unlocked(_empty_state())


def _read_raw_state_unlocked() -> tuple[dict, bool]:
    db_path = Path(DB_FILE)

    if not db_path.exists():
        empty_state = _empty_state()
        _write_state_unlocked(empty_state)
        return empty_state, False

    try:
        with open(db_path, "r", encoding="utf-8") as file:
            raw = json.load(file)
    except json.JSONDecodeError:
        corrupt_copy = _backup_corrupted_db(db_path)
        backup_state = _load_backup_state_unlocked()
        if backup_state is not None:
            logger.warning("状态文件损坏，已从备份恢复。corrupt_copy=%s", corrupt_copy or "n/a")
            _write_state_unlocked(backup_state)
            return backup_state, False

        logger.warning("状态文件损坏且备份不可用，已回退为空状态。corrupt_copy=%s", corrupt_copy or "n/a")
        empty_state = _empty_state()
        _write_state_unlocked(empty_state)
        return empty_state, False

    if not isinstance(raw, dict):
        logger.warning("状态文件结构非法，已回退为规范结构。path=%s", db_path)
        return _empty_state(), True

    return raw, False


def load_state() -> dict:
    _ensure_parent()
    with FileLock(LOCK_FILE, timeout=LOCK_TIMEOUT_SECONDS):
        raw, recovered = _read_raw_state_unlocked()
        try:
            normalized, changed = _normalize_state(raw)
        except ValueError as exc:
            return _restore_safe_state_unlocked(str(exc))
        if recovered or changed:
            normalized = _write_state_unlocked(normalized)
        return normalized


def save_state(state: dict) -> dict:
    _ensure_parent()
    with FileLock(LOCK_FILE, timeout=LOCK_TIMEOUT_SECONDS):
        return _write_state_unlocked(state)


def mutate_state(mutator) -> tuple[object, dict]:
    _ensure_parent()
    with FileLock(LOCK_FILE, timeout=LOCK_TIMEOUT_SECONDS):
        raw, recovered = _read_raw_state_unlocked()
        try:
            state, changed = _normalize_state(raw)
        except ValueError as exc:
            state = _restore_safe_state_unlocked(str(exc))
            changed = False
            recovered = True
        result, should_save = mutator(state)
        if recovered or changed or should_save:
            saved = _write_state_unlocked(state)
        else:
            saved = state
        return result, saved
