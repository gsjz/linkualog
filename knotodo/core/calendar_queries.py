from collections import defaultdict
from datetime import date, timedelta

from core.calendar_shared import (
    _decorate_events,
    _decorate_todos,
    _format_event_window,
)
from core.storage import WEEKDAY_KEYS, load_state


def _month_prefix(target_month: str | None) -> str:
    candidate = str(target_month or date.today().strftime("%Y-%m")).strip()
    try:
        date.fromisoformat(f"{candidate}-01")
    except ValueError:
        return date.today().strftime("%Y-%m")
    return candidate


def _event_type(item: dict) -> str:
    return str(item.get("event_type") or "interval").strip().lower()


def _event_weekdays(item: dict) -> list[str]:
    raw = item.get("repeat_weekdays") or []
    return [part for part in [str(value).strip().lower() for value in raw] if part in WEEKDAY_KEYS]


def _day_weekday_key(day: str) -> str:
    weekday_index = date.fromisoformat(day).weekday()
    return WEEKDAY_KEYS[weekday_index]


def _matches_recurring_on_day(event: dict, target_day: str) -> bool:
    if _event_type(event) != "recurring":
        return False

    target = date.fromisoformat(target_day)
    anchor_day = str(event.get("date") or "").strip()
    if anchor_day:
        anchor = date.fromisoformat(anchor_day)
        if target < anchor:
            return False

    rule = str(event.get("repeat_rule") or "none").strip().lower()
    if rule == "daily":
        return True
    if rule != "weekly":
        return False

    weekdays = _event_weekdays(event)
    if not weekdays and anchor_day:
        weekdays = [WEEKDAY_KEYS[date.fromisoformat(anchor_day).weekday()]]
    return _day_weekday_key(target_day) in weekdays


def _iter_month_days(month_prefix: str):
    first_day = date.fromisoformat(f"{month_prefix}-01")
    if first_day.month == 12:
        next_month = date(first_day.year + 1, 1, 1)
    else:
        next_month = date(first_day.year, first_day.month + 1, 1)

    cursor = first_day
    while cursor < next_month:
        yield cursor.isoformat()
        cursor += timedelta(days=1)


def _build_day_timed_events(events: list[dict], target_day: str) -> list[dict]:
    projected: list[dict] = []
    for event in events:
        event_type = _event_type(event)
        if event_type == "floating":
            continue

        if event_type == "recurring":
            if not _matches_recurring_on_day(event, target_day):
                continue
            projected.append({
                **event,
                "date": target_day,
                "occurrence_date": target_day,
            })
            continue

        if str(event.get("date") or "").strip() != target_day:
            continue
        projected.append(event)

    projected.sort(key=lambda item: (
        item.get("start_time") or "99:99",
        item.get("end_time") or "99:99",
        item.get("title", "").lower(),
        item.get("id", ""),
    ))
    return projected


def get_dashboard(target_month: str | None = None) -> dict:
    month_prefix = _month_prefix(target_month)
    state = load_state()
    calendar_days: dict[str, dict] = defaultdict(lambda: {
        "todo_total": 0,
        "todo_completed": 0,
        "event_total": 0,
        "priorities": {"high": 0, "medium": 0, "low": 0},
    })

    for todo in state["todos"]:
        day = todo["date"]
        if not day.startswith(month_prefix):
            continue
        calendar_days[day]["todo_total"] += 1
        if todo["completed"]:
            calendar_days[day]["todo_completed"] += 1
        calendar_days[day]["priorities"][todo["priority"]] += 1

    month_event_total = 0
    month_days = list(_iter_month_days(month_prefix))
    for event in state["events"]:
        event_type = _event_type(event)
        if event_type == "floating":
            continue

        if event_type == "recurring":
            for day in month_days:
                if _matches_recurring_on_day(event, day):
                    calendar_days[day]["event_total"] += 1
                    month_event_total += 1
            continue

        day = str(event.get("date") or "").strip()
        if not day.startswith(month_prefix):
            continue
        calendar_days[day]["event_total"] += 1
        month_event_total += 1

    month_todos = [item for item in state["todos"] if item["date"].startswith(month_prefix)]
    completed = sum(1 for item in month_todos if item["completed"])

    return {
        "month": month_prefix,
        "summary": {
            "todo_total": len(month_todos),
            "todo_completed": completed,
            "todo_open": len(month_todos) - completed,
            "event_total": month_event_total,
        },
        "calendar": dict(sorted(calendar_days.items())),
    }


def get_day_items(day: str) -> dict:
    target_day = str(day).strip()
    state = load_state()
    target_todos = [item for item in state["todos"] if item["date"] == target_day]
    target_events = _build_day_timed_events(state["events"], target_day)
    floating_events = [
        item
        for item in state["events"]
        if _event_type(item) == "floating" or not str(item.get("date") or "").strip()
    ]
    floating_events.sort(key=lambda item: (
        item.get("updated_at", ""),
        item.get("created_at", ""),
        item.get("title", "").lower(),
    ), reverse=True)
    return {
        "date": target_day,
        "todos": _decorate_todos(target_todos, state["events"]),
        "events": _decorate_events(target_events, state["todos"]),
        "floating_events": _decorate_events(floating_events, state["todos"]),
    }


def list_todos(day: str | None = None) -> list[dict]:
    target_day = str(day or "").strip()
    state = load_state()
    target_todos = state["todos"] if not target_day else [item for item in state["todos"] if item["date"] == target_day]
    return _decorate_todos(target_todos, state["events"])


def list_templates() -> list[dict]:
    state = load_state()
    return state.get("templates", [])


def list_events(day: str | None = None) -> list[dict]:
    target_day = str(day or "").strip()
    state = load_state()
    if not target_day:
        return _decorate_events(state["events"], state["todos"])
    target_events = _build_day_timed_events(state["events"], target_day)
    return _decorate_events(target_events, state["todos"])


def search_items(query: str, limit: int = 20) -> list[dict]:
    normalized_query = " ".join(str(query or "").strip().lower().split())
    if not normalized_query:
        return []

    safe_limit = max(1, min(int(limit or 20), 30))
    terms = normalized_query.split()
    state = load_state()
    todos = _decorate_todos(state["todos"], state["events"])
    events = _decorate_events(state["events"], state["todos"])
    results: list[dict] = []

    def build_caption(item: dict, item_type: str) -> str:
        if item_type == "todo":
            if item.get("notes"):
                return item["notes"]
            if item.get("completed"):
                return "已经完成。"
            if item.get("scheduled"):
                return "已绑定时间块。"
            return "待执行。"

        if item.get("notes"):
            return item["notes"]
        if item.get("linked_todo_title"):
            return f"Linked to {item['linked_todo_title']}"
        if _event_type(item) == "floating":
            return "无日期事件"
        if _event_type(item) == "recurring":
            return "周期事件"
        if _event_type(item) == "deadline":
            return "Deadline 事件"
        return "区间事件"

    def build_time_label(item: dict, item_type: str) -> str:
        if item_type == "todo":
            if item.get("due_time"):
                return item["due_time"]
            if item.get("completed"):
                return "Done"
            if item.get("scheduled"):
                return "Scheduled"
            return "No due"

        event_type = _event_type(item)
        if event_type == "floating":
            return "No date"
        if event_type == "recurring":
            rule = str(item.get("repeat_rule") or "weekly").strip().lower()
            return f"{_format_event_window(item)} · {rule}"
        return _format_event_window(item)

    def match_score(item: dict, item_type: str) -> int:
        title = str(item.get("title") or "").lower()
        notes = str(item.get("notes") or "").lower()
        date_label = str(item.get("date") or "unscheduled").lower()
        time_label = build_time_label(item, item_type).lower()
        linked_todo_title = str(item.get("linked_todo_title") or "").lower()
        searchable = " ".join(part for part in [title, notes, date_label, time_label, linked_todo_title] if part)

        score = 0
        for term in terms:
            if term not in searchable:
                return 0
            if title.startswith(term):
                score += 14
            elif term in title:
                score += 10
            if term in notes:
                score += 4
            if term in linked_todo_title:
                score += 3
            if term in date_label or term in time_label:
                score += 2
        if item_type == "todo" and not item.get("completed"):
            score += 1
        return score

    for item in todos:
        score = match_score(item, "todo")
        if score <= 0:
            continue
        results.append({
            "id": item["id"],
            "type": "todo",
            "date": item["date"],
            "title": item["title"],
            "caption": build_caption(item, "todo"),
            "time_label": build_time_label(item, "todo"),
            "tone": "teal" if item["completed"] else ("coral" if item["priority"] == "high" else "teal" if item["priority"] == "low" else "slate"),
            "score": score,
            "completed": bool(item["completed"]),
        })

    for item in events:
        score = match_score(item, "event")
        if score <= 0:
            continue
        results.append({
            "id": item["id"],
            "type": "event",
            "date": item.get("date") or "",
            "title": item["title"],
            "caption": build_caption(item, "event"),
            "time_label": build_time_label(item, "event"),
            "tone": item.get("color", "slate"),
            "score": score,
            "completed": bool(item.get("linked_todo_completed", False)),
        })

    results.sort(key=lambda item: (
        -item["score"],
        item["date"] or "9999-12-31",
        item["time_label"],
        item["title"].lower(),
        item["id"],
    ))
    return [{key: value for key, value in item.items() if key != "score"} for item in results[:safe_limit]]
