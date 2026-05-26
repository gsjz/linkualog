from uuid import uuid4

from core.calendar_shared import (
    CalendarValidationError,
    _decorate_events,
    _decorate_todos,
    _run_mutation,
    _sync_linked_todo_schedule,
    _validate_event_candidate,
    _validate_source_todo_id,
    _validate_todo_schedule_patch,
)
from core.storage import _normalize_event, _normalize_template


def create_todo(payload: dict) -> dict:
    created_id = str(payload.get("id") or uuid4())

    def mutator(state: dict) -> tuple[str, bool]:
        state["todos"].append({**payload, "id": created_id})
        return created_id, True

    _, saved = _run_mutation(mutator)
    for item in saved["todos"]:
        if item["id"] == created_id:
            return _decorate_todos([item], saved["events"])[0]
    return _decorate_todos([saved["todos"][-1]], saved["events"])[0]


def create_template(payload: dict) -> dict:
    created_id = str(payload.get("id") or uuid4())

    def mutator(state: dict) -> tuple[str, bool]:
        state.setdefault("templates", []).append({**payload, "id": created_id})
        return created_id, True

    _, saved = _run_mutation(mutator)
    for item in saved.get("templates", []):
        if item["id"] == created_id:
            return item
    return _normalize_template({**payload, "id": created_id})


def update_template(template_id: str, payload: dict) -> dict | None:
    def mutator(state: dict) -> tuple[str | None, bool]:
        templates = state.setdefault("templates", [])
        for index, template in enumerate(templates):
            if template["id"] != template_id:
                continue
            templates[index] = {**template, **payload}
            return template_id, True
        return None, False

    updated_id, saved = _run_mutation(mutator)
    if updated_id is None:
        return None
    for item in saved.get("templates", []):
        if item["id"] == template_id:
            return item
    return None


def delete_template(template_id: str) -> bool:
    def mutator(state: dict) -> tuple[bool, bool]:
        templates = state.setdefault("templates", [])
        next_templates = [item for item in templates if item["id"] != template_id]
        deleted = len(next_templates) != len(templates)
        if not deleted:
            return False, False
        state["templates"] = next_templates
        return True, True

    deleted, _ = _run_mutation(mutator)
    return bool(deleted)


def update_todo(todo_id: str, payload: dict) -> dict | None:
    def mutator(state: dict) -> tuple[str | None, bool]:
        for index, todo in enumerate(state["todos"]):
            if todo["id"] != todo_id:
                continue
            _validate_todo_schedule_patch(state, todo, payload)
            state["todos"][index] = {**todo, **payload}
            return todo_id, True
        return None, False

    updated_id, saved = _run_mutation(mutator)
    if updated_id is None:
        return None
    for item in saved["todos"]:
        if item["id"] == todo_id:
            return _decorate_todos([item], saved["events"])[0]
    return None


def delete_todo(todo_id: str) -> bool:
    def mutator(state: dict) -> tuple[bool, bool]:
        original = len(state["todos"])
        state["todos"] = [item for item in state["todos"] if item["id"] != todo_id]
        deleted = len(state["todos"]) != original
        if not deleted:
            return False, False
        for event in state["events"]:
            if event.get("source_todo_id") == todo_id:
                event["source_todo_id"] = ""
        return True, True

    deleted, _ = _run_mutation(mutator)
    return bool(deleted)


def create_event(payload: dict) -> dict:
    created_id = str(payload.get("id") or uuid4())

    def mutator(state: dict) -> tuple[str, bool]:
        try:
            candidate = _normalize_event({**payload, "id": created_id})
        except ValueError as exc:
            raise CalendarValidationError("时间格式无效，请使用 HH:MM。", status_code=422) from exc
        _validate_source_todo_id(state["todos"], candidate.get("source_todo_id", ""))
        _validate_event_candidate(state["events"], candidate)
        state["events"].append(candidate)
        _sync_linked_todo_schedule(state, candidate.get("source_todo_id", ""))
        return created_id, True

    _, saved = _run_mutation(mutator)
    for item in saved["events"]:
        if item["id"] == created_id:
            return _decorate_events([item], saved["todos"])[0]
    return _decorate_events([saved["events"][-1]], saved["todos"])[0]


def update_event(event_id: str, payload: dict) -> dict | None:
    def mutator(state: dict) -> tuple[str | None, bool]:
        for index, event in enumerate(state["events"]):
            if event["id"] != event_id:
                continue
            try:
                next_event = _normalize_event({**event, **payload})
            except ValueError as exc:
                raise CalendarValidationError("时间格式无效，请使用 HH:MM。", status_code=422) from exc
            _validate_source_todo_id(state["todos"], next_event.get("source_todo_id", ""))
            _validate_event_candidate(state["events"], next_event, exclude_id=event_id)
            state["events"][index] = next_event
            linked_ids = {
                str(event.get("source_todo_id") or "").strip(),
                str(next_event.get("source_todo_id") or "").strip(),
            }
            for linked_id in linked_ids:
                _sync_linked_todo_schedule(state, linked_id)
            return event_id, True
        return None, False

    updated_id, saved = _run_mutation(mutator)
    if updated_id is None:
        return None
    for item in saved["events"]:
        if item["id"] == event_id:
            return _decorate_events([item], saved["todos"])[0]
    return None


def delete_event(event_id: str) -> bool:
    def mutator(state: dict) -> tuple[bool, bool]:
        removed_event = next((item for item in state["events"] if item["id"] == event_id), None)
        if removed_event is None:
            return False, False
        state["events"] = [item for item in state["events"] if item["id"] != event_id]
        _sync_linked_todo_schedule(state, removed_event.get("source_todo_id", ""))
        return True, True

    deleted, _ = _run_mutation(mutator)
    return bool(deleted)
