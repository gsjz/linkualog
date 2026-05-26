from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from api.errors import run_calendar_action
from api.schemas import (
    BoardPatchPayload,
    BoardPayload,
    LaneArchivePayload,
    CardMovePayload,
    CardPatchPayload,
    CardPayload,
    EventPatchPayload,
    EventPayload,
    LaneMovePayload,
    LanePatchPayload,
    LanePayload,
    TemplatePatchPayload,
    TemplatePayload,
    TodoPatchPayload,
    TodoPayload,
)
from core.calendar import (
    create_event,
    create_template,
    create_todo,
    delete_event,
    delete_template,
    delete_todo,
    get_dashboard,
    get_day_items,
    list_events,
    list_templates,
    list_todos,
    search_items,
    update_event,
    update_template,
    update_todo,
)
from core.kanban import (
    create_board,
    create_card,
    create_lane,
    delete_board,
    delete_card,
    delete_lane,
    get_board_view,
    list_boards,
    set_lane_cards_archived,
    move_card,
    move_lane,
    update_board,
    update_card,
    update_lane,
)
from core.storage import load_state

router = APIRouter()


def _with_updated_at(payload: dict) -> dict:
    return {
        **payload,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


@router.get("/api/health")
def health() -> dict:
    state = load_state()
    return {
        "status": "ok",
        "todos": len(state["todos"]),
        "events": len(state["events"]),
        "boards": len(state.get("boards", [])),
        "cards": len(state.get("cards", [])),
    }


@router.get("/api/dashboard")
def dashboard(month: str | None = None) -> dict:
    return get_dashboard(month)


@router.get("/api/day/{day}")
def day_view(day: str) -> dict:
    return get_day_items(day)


@router.get("/api/search")
def search(q: str = "", limit: int = 20) -> dict:
    return {"items": search_items(q, limit)}


@router.get("/api/boards")
def boards() -> dict:
    return {"items": list_boards()}


@router.post("/api/boards")
def add_board(payload: BoardPayload) -> dict:
    created = run_calendar_action(lambda: create_board(payload.model_dump()))
    return {"item": created}


@router.get("/api/boards/{board_id}")
def board_view(board_id: str, day: str | None = None, include_archived: bool = False) -> dict:
    payload = get_board_view(board_id, day, include_archived=include_archived)
    if payload is None:
        raise HTTPException(status_code=404, detail="Board not found")
    return payload


@router.patch("/api/boards/{board_id}")
def patch_board(board_id: str, payload: BoardPatchPayload) -> dict:
    updated = run_calendar_action(lambda: update_board(board_id, payload.model_dump(exclude_none=True)))
    if updated is None:
        raise HTTPException(status_code=404, detail="Board not found")
    return {"item": updated}


@router.delete("/api/boards/{board_id}")
def remove_board(board_id: str) -> dict:
    if not delete_board(board_id):
        raise HTTPException(status_code=404, detail="Board not found")
    return {"status": "deleted"}


@router.post("/api/lanes")
def add_lane(payload: LanePayload) -> dict:
    created = run_calendar_action(lambda: create_lane(payload.model_dump()))
    return {"item": created}


@router.patch("/api/lanes/{lane_id}")
def patch_lane(lane_id: str, payload: LanePatchPayload) -> dict:
    updated = run_calendar_action(lambda: update_lane(lane_id, payload.model_dump(exclude_none=True)))
    if updated is None:
        raise HTTPException(status_code=404, detail="Lane not found")
    return {"item": updated}


@router.post("/api/lanes/{lane_id}/move")
def post_move_lane(lane_id: str, payload: LaneMovePayload) -> dict:
    updated = run_calendar_action(lambda: move_lane(lane_id, payload.position))
    if updated is None:
        raise HTTPException(status_code=404, detail="Lane not found")
    return {"item": updated}


@router.post("/api/lanes/{lane_id}/archive")
def post_archive_lane_cards(lane_id: str, payload: LaneArchivePayload) -> dict:
    result = run_calendar_action(lambda: set_lane_cards_archived(lane_id, payload.archived))
    if result is None:
        raise HTTPException(status_code=404, detail="Lane not found")
    return {"item": result}


@router.delete("/api/lanes/{lane_id}")
def remove_lane(lane_id: str) -> dict:
    if not delete_lane(lane_id):
        raise HTTPException(status_code=404, detail="Lane not found")
    return {"status": "deleted"}


@router.post("/api/cards")
def add_card(payload: CardPayload) -> dict:
    created = run_calendar_action(lambda: create_card(payload.model_dump()))
    return {"item": created}


@router.patch("/api/cards/{card_id}")
def patch_card(card_id: str, payload: CardPatchPayload) -> dict:
    updated = run_calendar_action(lambda: update_card(card_id, payload.model_dump(exclude_none=True)))
    if updated is None:
        raise HTTPException(status_code=404, detail="Card not found")
    return {"item": updated}


@router.post("/api/cards/{card_id}/move")
def post_move_card(card_id: str, payload: CardMovePayload) -> dict:
    move_payload = payload.model_dump(exclude_none=True)
    updated = run_calendar_action(lambda: move_card(card_id, **move_payload))
    if updated is None:
        raise HTTPException(status_code=404, detail="Card not found")
    return {"item": updated}


@router.delete("/api/cards/{card_id}")
def remove_card(card_id: str) -> dict:
    if not delete_card(card_id):
        raise HTTPException(status_code=404, detail="Card not found")
    return {"status": "deleted"}


@router.get("/api/templates")
def templates() -> dict:
    return {"items": list_templates()}


@router.post("/api/templates")
def add_template(payload: TemplatePayload) -> dict:
    created = run_calendar_action(lambda: create_template(payload.model_dump()))
    return {"item": created}


@router.patch("/api/templates/{template_id}")
def patch_template(template_id: str, payload: TemplatePatchPayload) -> dict:
    updated = run_calendar_action(
        lambda: update_template(template_id, _with_updated_at(payload.model_dump(exclude_none=True))),
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"item": updated}


@router.delete("/api/templates/{template_id}")
def remove_template(template_id: str) -> dict:
    if not delete_template(template_id):
        raise HTTPException(status_code=404, detail="Template not found")
    return {"status": "deleted"}


@router.get("/api/todos")
def todos(day: str | None = None) -> dict:
    return {"items": list_todos(day)}


@router.post("/api/todos")
def add_todo(payload: TodoPayload) -> dict:
    created = run_calendar_action(lambda: create_todo(payload.model_dump()))
    return {"item": created}


@router.patch("/api/todos/{todo_id}")
def patch_todo(todo_id: str, payload: TodoPatchPayload) -> dict:
    updated = run_calendar_action(lambda: update_todo(todo_id, _with_updated_at(payload.model_dump(exclude_none=True))))
    if updated is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return {"item": updated}


@router.delete("/api/todos/{todo_id}")
def remove_todo(todo_id: str) -> dict:
    if not delete_todo(todo_id):
        raise HTTPException(status_code=404, detail="Todo not found")
    return {"status": "deleted"}


@router.get("/api/events")
def events(day: str | None = None) -> dict:
    return {"items": list_events(day)}


@router.post("/api/events")
def add_event(payload: EventPayload) -> dict:
    created = run_calendar_action(lambda: create_event(payload.model_dump()))
    return {"item": created}


@router.patch("/api/events/{event_id}")
def patch_event(event_id: str, payload: EventPatchPayload) -> dict:
    updated = run_calendar_action(lambda: update_event(event_id, _with_updated_at(payload.model_dump(exclude_none=True))))
    if updated is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"item": updated}


@router.delete("/api/events/{event_id}")
def remove_event(event_id: str) -> dict:
    if not delete_event(event_id):
        raise HTTPException(status_code=404, detail="Event not found")
    return {"status": "deleted"}
