from datetime import datetime, timezone

from core.storage import mutate_state

DAY_EVENT_TYPES = {"interval", "deadline"}


class CalendarValidationError(Exception):
    def __init__(self, detail: str, status_code: int = 422):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _parse_time_to_minutes(value: str) -> int | None:
    candidate = str(value or "").strip()
    if not candidate:
        return None
    hours_text, minutes_text = candidate.split(":", 1)
    return int(hours_text) * 60 + int(minutes_text)


def _format_event_window(item: dict) -> str:
    return f"{item.get('start_time') or '--:--'} - {item.get('end_time') or '--:--'}"


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _event_sort_key(item: dict) -> tuple:
    return (
        item.get("date") or "9999-12-31",
        item.get("start_time") or "99:99",
        item.get("end_time") or "99:99",
        item.get("title", "").lower(),
        item.get("id", ""),
    )


def _find_event_conflicts(events: list[dict], candidate: dict, exclude_id: str | None = None) -> list[dict]:
    candidate_type = str(candidate.get("event_type") or "interval").strip().lower()
    if candidate_type not in DAY_EVENT_TYPES:
        return []
    candidate_date = str(candidate.get("date") or "").strip()
    if not candidate_date:
        return []

    candidate_start = _parse_time_to_minutes(candidate["start_time"])
    candidate_end = _parse_time_to_minutes(candidate["end_time"])
    if candidate_start is None or candidate_end is None:
        return []

    conflicts: list[dict] = []
    for item in events:
        if exclude_id and item["id"] == exclude_id:
            continue
        item_type = str(item.get("event_type") or "interval").strip().lower()
        if item_type not in DAY_EVENT_TYPES:
            continue
        if item.get("date") != candidate_date:
            continue

        start = _parse_time_to_minutes(item["start_time"])
        end = _parse_time_to_minutes(item["end_time"])
        if start is None or end is None or end <= start:
            continue
        if candidate_end <= start or candidate_start >= end:
            continue
        conflicts.append(item)

    return conflicts


def _validate_event_candidate(events: list[dict], candidate: dict, exclude_id: str | None = None) -> None:
    event_type = str(candidate.get("event_type") or "interval").strip().lower()
    if event_type == "floating":
        return

    date_value = str(candidate.get("date") or "").strip()
    start_time = candidate["start_time"]
    end_time = candidate["end_time"]
    repeat_rule = str(candidate.get("repeat_rule") or "none").strip().lower()
    repeat_weekdays = [str(item).strip().lower() for item in (candidate.get("repeat_weekdays") or []) if str(item).strip()]

    if not start_time or not end_time:
        raise CalendarValidationError("时间块必须同时填写开始和结束时间。", status_code=422)
    if _parse_time_to_minutes(end_time) <= _parse_time_to_minutes(start_time):
        raise CalendarValidationError("结束时间必须晚于开始时间。", status_code=422)

    if event_type == "recurring":
        if repeat_rule not in {"daily", "weekly"}:
            raise CalendarValidationError("周期事件规则无效，仅支持 daily / weekly。", status_code=422)
        if repeat_rule == "weekly" and not repeat_weekdays:
            raise CalendarValidationError("每周周期事件至少选择一个星期。", status_code=422)
        return

    if not date_value:
        raise CalendarValidationError("该事件类型必须指定日期。", status_code=422)

    conflicts = _find_event_conflicts(events, candidate, exclude_id)
    if not conflicts:
        return

    labels = [f"{item['title']} ({_format_event_window(item)})" for item in conflicts[:2]]
    if len(conflicts) > 2:
        labels.append(f"以及另外 {len(conflicts) - 2} 个时间块")
    raise CalendarValidationError(f"时间块冲突：{candidate['title']} 与 {'、'.join(labels)} 重叠。", status_code=409)


def _validate_source_todo_id(todos: list[dict], source_todo_id: str) -> None:
    linked_id = str(source_todo_id or "").strip()
    if not linked_id:
        return
    if any(item["id"] == linked_id for item in todos):
        return
    raise CalendarValidationError("关联的任务不存在。", status_code=404)


def _run_mutation(mutator):
    try:
        return mutate_state(mutator)
    except ValueError as exc:
        raise CalendarValidationError("日期或时间格式无效，请使用 YYYY-MM-DD / HH:MM。", status_code=422) from exc


def _todo_has_linked_blocks(events: list[dict], todo_id: str) -> bool:
    linked_id = str(todo_id or "").strip()
    if not linked_id:
        return False
    return any(
        str(item.get("source_todo_id") or "").strip() == linked_id
        and str(item.get("event_type") or "interval").strip().lower() in DAY_EVENT_TYPES
        and bool(item.get("date"))
        and bool(item.get("start_time"))
        for item in events
    )


def _validate_todo_schedule_patch(state: dict, todo: dict, payload: dict) -> None:
    if not _todo_has_linked_blocks(state["events"], todo["id"]):
        return

    next_date = str(payload.get("date", todo.get("date", "")) or "").strip()
    next_due_time = str(payload.get("due_time", todo.get("due_time", "")) or "").strip()
    current_date = str(todo.get("date", "") or "").strip()
    current_due_time = str(todo.get("due_time", "") or "").strip()

    if next_date != current_date or next_due_time != current_due_time:
        raise CalendarValidationError("已排程任务的时间由关联 block 控制，请移动对应时间块。", status_code=409)


def _collect_todo_schedule_metrics(events: list[dict]) -> dict[str, dict]:
    metrics_by_todo_id: dict[str, dict] = {}

    for event in sorted(events, key=_event_sort_key):
        linked_id = str(event.get("source_todo_id") or "").strip()
        if not linked_id:
            continue
        if str(event.get("event_type") or "interval").strip().lower() not in DAY_EVENT_TYPES:
            continue
        if not event.get("date"):
            continue

        start_minutes = _parse_time_to_minutes(event.get("start_time"))
        end_minutes = _parse_time_to_minutes(event.get("end_time"))
        duration_minutes = 0
        if start_minutes is not None and end_minutes is not None and end_minutes > start_minutes:
            duration_minutes = end_minutes - start_minutes

        entry = metrics_by_todo_id.setdefault(linked_id, {
            "scheduled_count": 0,
            "scheduled_minutes": 0,
            "next_scheduled_date": "",
            "next_scheduled_time": "",
            "linked_blocks": [],
        })
        entry["scheduled_count"] += 1
        entry["scheduled_minutes"] += duration_minutes
        if not entry["next_scheduled_date"]:
            entry["next_scheduled_date"] = event.get("date", "")
            entry["next_scheduled_time"] = event.get("start_time", "")
        entry["linked_blocks"].append({
            "id": event.get("id", ""),
            "date": event.get("date", ""),
            "start_time": event.get("start_time", ""),
            "end_time": event.get("end_time", ""),
            "color": event.get("color", "slate"),
        })

    return metrics_by_todo_id


def _sync_linked_todo_schedule(state: dict, todo_id: str) -> None:
    linked_id = str(todo_id or "").strip()
    if not linked_id:
        return

    todo_index = next((index for index, item in enumerate(state["todos"]) if item["id"] == linked_id), None)
    if todo_index is None:
        return

    linked_events = sorted(
        [
            item
            for item in state["events"]
            if str(item.get("source_todo_id") or "").strip() == linked_id
            and str(item.get("event_type") or "interval").strip().lower() in DAY_EVENT_TYPES
            and bool(item.get("date"))
            and bool(item.get("start_time"))
        ],
        key=_event_sort_key,
    )
    if not linked_events:
        return

    primary_event = linked_events[0]
    current_todo = state["todos"][todo_index]
    next_date = primary_event.get("date") or current_todo.get("date", "")
    next_due_time = primary_event.get("start_time") or current_todo.get("due_time", "")

    if current_todo.get("date") == next_date and current_todo.get("due_time", "") == next_due_time:
        return

    state["todos"][todo_index] = {
        **current_todo,
        "date": next_date,
        "due_time": next_due_time,
        "updated_at": _utc_timestamp(),
    }


def _decorate_todos(todos: list[dict], events: list[dict]) -> list[dict]:
    metrics_by_todo_id = _collect_todo_schedule_metrics(events)

    return [
        {
            **item,
            "scheduled": metrics_by_todo_id.get(item["id"], {}).get("scheduled_count", 0) > 0,
            "scheduled_count": metrics_by_todo_id.get(item["id"], {}).get("scheduled_count", 0),
            "scheduled_minutes": metrics_by_todo_id.get(item["id"], {}).get("scheduled_minutes", 0),
            "next_scheduled_date": metrics_by_todo_id.get(item["id"], {}).get("next_scheduled_date", ""),
            "next_scheduled_time": metrics_by_todo_id.get(item["id"], {}).get("next_scheduled_time", ""),
            "linked_blocks": metrics_by_todo_id.get(item["id"], {}).get("linked_blocks", []),
        }
        for item in todos
    ]


def _decorate_events(events: list[dict], todos: list[dict]) -> list[dict]:
    todos_by_id = {item["id"]: item for item in todos}
    decorated: list[dict] = []

    for event in events:
        linked_id = str(event.get("source_todo_id") or "").strip()
        linked_todo = todos_by_id.get(linked_id)
        decorated.append({
            **event,
            "source_todo_id": linked_id,
            "linked_todo_title": linked_todo["title"] if linked_todo else "",
            "linked_todo_priority": linked_todo["priority"] if linked_todo else "",
            "linked_todo_completed": bool(linked_todo["completed"]) if linked_todo else False,
            "linked_todo_missing": bool(linked_id and linked_todo is None),
        })

    return decorated
