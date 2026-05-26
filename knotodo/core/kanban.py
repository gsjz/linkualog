from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from core.calendar_shared import CalendarValidationError
from core.storage import (
    BLOCK_COLOR_KEYS,
    CARD_EVENT_TYPE_KEYS,
    WEEKDAY_KEYS,
    load_state,
    mutate_state,
)

POSITION_STEP = 1024
DEADLINE_WINDOW_MINUTES = 30


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _normalize_time_text(value: str | None) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    return datetime.strptime(candidate, "%H:%M").strftime("%H:%M")


def _normalize_date_text(value: str | None) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    return date.fromisoformat(candidate).isoformat()


def _normalize_color(value: str | None, fallback: str = "slate") -> str:
    candidate = str(value or fallback).strip().lower()
    if candidate not in BLOCK_COLOR_KEYS:
        return fallback
    return candidate


def _normalize_event_type(value: str | None) -> str:
    candidate = str(value or "none").strip().lower()
    if candidate not in CARD_EVENT_TYPE_KEYS:
        return "none"
    return candidate


def _normalize_repeat_rule(value: str | None) -> str:
    candidate = str(value or "none").strip().lower()
    if candidate not in {"none", "daily", "weekly"}:
        return "none"
    return candidate


def _normalize_short_list(value, max_items: int = 10, max_length: int = 24) -> list[str]:
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


def _normalize_weekdays(value) -> list[str]:
    if isinstance(value, str):
        raw_items = [part.strip().lower() for part in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        raw_items = [str(part).strip().lower() for part in value]
    else:
        raw_items = []

    normalized = []
    seen = set()
    for item in raw_items:
        if item not in WEEKDAY_KEYS or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def _normalize_checklist(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    normalized = []
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


def _parse_time_minutes(value: str | None) -> int | None:
    candidate = str(value or "").strip()
    if not candidate:
        return None
    hours_text, minutes_text = candidate.split(":", 1)
    return int(hours_text) * 60 + int(minutes_text)


def _minutes_to_time(value: int) -> str:
    hours = (value // 60) % 24
    minutes = value % 60
    return f"{hours:02d}:{minutes:02d}"


def _resolve_deadline_window(start_time: str | None, end_time: str | None) -> tuple[str, str]:
    start_minutes = _parse_time_minutes(start_time)
    end_minutes = _parse_time_minutes(end_time)
    if start_minutes is None and end_minutes is None:
        return "", ""

    if end_minutes is None and start_minutes is not None:
        end_minutes = start_minutes
    if end_minutes is None:
        return "", ""

    if start_minutes is None or start_minutes >= end_minutes:
        start_minutes = max(0, end_minutes - DEADLINE_WINDOW_MINUTES)
    if start_minutes == end_minutes:
        if end_minutes < 24 * 60 - 1:
            end_minutes += 1
        else:
            start_minutes = max(0, end_minutes - 1)

    return _minutes_to_time(start_minutes), _minutes_to_time(end_minutes)


def _find_board(state: dict, board_id: str) -> dict | None:
    return next((item for item in state.get("boards", []) if item["id"] == board_id), None)


def _find_lane(state: dict, lane_id: str) -> dict | None:
    return next((item for item in state.get("lanes", []) if item["id"] == lane_id), None)


def _find_card(state: dict, card_id: str) -> dict | None:
    return next((item for item in state.get("cards", []) if item["id"] == card_id), None)


def _sorted_board_lanes(state: dict, board_id: str) -> list[dict]:
    lanes = [item for item in state.get("lanes", []) if item.get("board_id") == board_id]
    return sorted(lanes, key=lambda item: (int(item.get("position", POSITION_STEP)), item.get("created_at", ""), item.get("id", "")))


def _sorted_lane_cards(state: dict, lane_id: str) -> list[dict]:
    cards = [item for item in state.get("cards", []) if item.get("lane_id") == lane_id]
    return sorted(cards, key=lambda item: (int(item.get("position", POSITION_STEP)), item.get("updated_at", ""), item.get("id", "")))


def _touch_board(state: dict, board_id: str) -> None:
    board = _find_board(state, board_id)
    if board:
        board["updated_at"] = _utc_timestamp()


def _resequence_lanes(state: dict, board_id: str, moving_lane_id: str | None = None, target_index: int | None = None) -> None:
    ordered = _sorted_board_lanes(state, board_id)
    if moving_lane_id:
        moving = next((item for item in ordered if item["id"] == moving_lane_id), None)
        if moving:
            ordered = [item for item in ordered if item["id"] != moving_lane_id]
            if target_index is None:
                target_index = len(ordered)
            target = max(0, min(int(target_index), len(ordered)))
            ordered.insert(target, moving)

    now = _utc_timestamp()
    for index, lane in enumerate(ordered):
        lane["position"] = (index + 1) * POSITION_STEP
        lane["updated_at"] = now


def _resequence_cards(state: dict, lane_id: str, moving_card_id: str | None = None, target_index: int | None = None) -> None:
    ordered = _sorted_lane_cards(state, lane_id)
    if moving_card_id:
        moving = next((item for item in ordered if item["id"] == moving_card_id), None)
        if moving:
            ordered = [item for item in ordered if item["id"] != moving_card_id]
            if target_index is None:
                target_index = len(ordered)
            target = max(0, min(int(target_index), len(ordered)))
            ordered.insert(target, moving)

    now = _utc_timestamp()
    for index, card in enumerate(ordered):
        card["position"] = (index + 1) * POSITION_STEP
        card["updated_at"] = now


def _resolve_card_target_index(
    state: dict,
    lane_id: str,
    moving_card_id: str,
    position: int | None = None,
    before_card_id: str | None = None,
    after_card_id: str | None = None,
) -> int | None:
    if before_card_id and after_card_id:
        raise CalendarValidationError("before_card_id 和 after_card_id 不能同时提供。", status_code=422)
    if not before_card_id and not after_card_id:
        return position

    ordered = [item for item in _sorted_lane_cards(state, lane_id) if item["id"] != moving_card_id]
    if before_card_id:
        target = next((index for index, item in enumerate(ordered) if item["id"] == before_card_id), None)
        if target is None:
            raise CalendarValidationError("目标前置卡片不存在或不在目标列表中。", status_code=404)
        return target

    target = next((index for index, item in enumerate(ordered) if item["id"] == after_card_id), None)
    if target is None:
        raise CalendarValidationError("目标后置卡片不存在或不在目标列表中。", status_code=404)
    return target + 1


def _validate_card_event_payload(payload: dict, partial: bool = False) -> None:
    event_type = _normalize_event_type(payload.get("event_type"))
    date_value = _normalize_date_text(payload.get("date")) if "date" in payload else str(payload.get("date") or "").strip()
    repeat_end_date = _normalize_date_text(payload.get("repeat_end_date")) if "repeat_end_date" in payload else str(payload.get("repeat_end_date") or "").strip()
    start_time = _normalize_time_text(payload.get("start_time")) if "start_time" in payload else str(payload.get("start_time") or "").strip()
    end_time = _normalize_time_text(payload.get("end_time")) if "end_time" in payload else str(payload.get("end_time") or "").strip()
    repeat_rule = _normalize_repeat_rule(payload.get("repeat_rule"))
    repeat_weekdays = _normalize_weekdays(payload.get("repeat_weekdays"))

    if partial and event_type == "none" and "event_type" not in payload:
        return

    if event_type == "none":
        return

    if event_type in {"interval", "deadline"} and not date_value:
        raise CalendarValidationError("区间/Deadline 卡片必须指定日期。", status_code=422)
    if event_type == "deadline":
        deadline_start, deadline_end = _resolve_deadline_window(start_time, end_time)
        if not deadline_start or not deadline_end:
            raise CalendarValidationError("Deadline 卡片必须填写截止时间。", status_code=422)
    if event_type in {"interval", "recurring"}:
        if not start_time or not end_time:
            raise CalendarValidationError("时间事件必须填写开始和结束时间。", status_code=422)
        start_minutes = _parse_time_minutes(start_time)
        end_minutes = _parse_time_minutes(end_time)
        if start_minutes is None or end_minutes is None or start_minutes == end_minutes:
            raise CalendarValidationError("开始和结束时间无效。", status_code=422)
    if event_type == "recurring":
        if not date_value:
            raise CalendarValidationError("周期卡片必须设置起始日期。", status_code=422)
        if repeat_rule not in {"daily", "weekly"}:
            raise CalendarValidationError("周期规则仅支持 daily / weekly。", status_code=422)
        if repeat_rule == "weekly" and not repeat_weekdays:
            raise CalendarValidationError("每周周期卡片至少选择一个星期。", status_code=422)
        if repeat_end_date and date_value and repeat_end_date < date_value:
            raise CalendarValidationError("周期中止日期不能早于起始日期。", status_code=422)


def _apply_card_patch(card: dict, payload: dict, state: dict) -> tuple[str, str]:
    old_lane_id = card["lane_id"]
    old_board_id = card["board_id"]

    if "lane_id" in payload:
        lane_id = str(payload.get("lane_id") or "").strip()
        lane = _find_lane(state, lane_id)
        if lane is None:
            raise CalendarValidationError("目标列表不存在。", status_code=404)
        card["lane_id"] = lane["id"]
        card["board_id"] = lane["board_id"]
    elif "board_id" in payload:
        board_id = str(payload.get("board_id") or "").strip()
        board = _find_board(state, board_id)
        if board is None:
            raise CalendarValidationError("目标看板不存在。", status_code=404)
        board_lanes = _sorted_board_lanes(state, board_id)
        if not board_lanes:
            raise CalendarValidationError("目标看板没有可用列表。", status_code=409)
        card["board_id"] = board_id
        card["lane_id"] = board_lanes[0]["id"]

    if "title" in payload:
        title = str(payload.get("title") or "").strip()
        if not title:
            raise CalendarValidationError("卡片标题不能为空。", status_code=422)
        card["title"] = title[:160]
    if "description" in payload:
        card["description"] = str(payload.get("description") or "").strip()[:4000]
    if "labels" in payload:
        card["labels"] = _normalize_short_list(payload.get("labels"), max_items=10, max_length=24)
    if "members" in payload:
        card["members"] = _normalize_short_list(payload.get("members"), max_items=12, max_length=24)
    if "checklist" in payload:
        card["checklist"] = _normalize_checklist(payload.get("checklist"))
    if "due_date" in payload:
        card["due_date"] = _normalize_date_text(payload.get("due_date"))
    if "color" in payload:
        card["color"] = _normalize_color(payload.get("color"), "slate")

    if "event_type" in payload:
        card["event_type"] = _normalize_event_type(payload.get("event_type"))
    if "date" in payload:
        card["date"] = _normalize_date_text(payload.get("date"))
    if "repeat_end_date" in payload:
        card["repeat_end_date"] = _normalize_date_text(payload.get("repeat_end_date"))
    if "start_time" in payload:
        card["start_time"] = _normalize_time_text(payload.get("start_time"))
    if "end_time" in payload:
        card["end_time"] = _normalize_time_text(payload.get("end_time"))
    if "repeat_rule" in payload:
        card["repeat_rule"] = _normalize_repeat_rule(payload.get("repeat_rule"))
    if "repeat_weekdays" in payload:
        card["repeat_weekdays"] = _normalize_weekdays(payload.get("repeat_weekdays"))
    if "archived" in payload:
        is_archived = bool(payload.get("archived"))
        card["archived"] = is_archived
        card["archived_at"] = _utc_timestamp() if is_archived else ""

    event_type = _normalize_event_type(card.get("event_type"))
    card["event_type"] = event_type
    if event_type == "none":
        card["date"] = ""
        card["repeat_end_date"] = ""
        card["start_time"] = ""
        card["end_time"] = ""
        card["repeat_rule"] = "none"
        card["repeat_weekdays"] = []
    elif event_type == "deadline":
        card["repeat_end_date"] = ""
        card["repeat_rule"] = "none"
        card["repeat_weekdays"] = []
        deadline_start, deadline_end = _resolve_deadline_window(card.get("start_time"), card.get("end_time"))
        card["start_time"] = deadline_start
        card["end_time"] = deadline_end
        if not card.get("due_date") and card.get("date"):
            card["due_date"] = card.get("date", "")
    elif event_type == "interval":
        card["repeat_end_date"] = ""
        card["repeat_rule"] = "none"
        card["repeat_weekdays"] = []
    elif event_type == "recurring":
        if card.get("repeat_rule") not in {"daily", "weekly"}:
            card["repeat_rule"] = "weekly"
        if card.get("repeat_rule") == "weekly" and not card.get("repeat_weekdays"):
            anchor_date = str(card.get("date") or "").strip()
            if anchor_date:
                weekday = WEEKDAY_KEYS[date.fromisoformat(anchor_date).weekday()]
                card["repeat_weekdays"] = [weekday]

    _validate_card_event_payload(card)
    card["updated_at"] = _utc_timestamp()
    return old_lane_id, old_board_id


def _board_summary(state: dict, board: dict) -> dict:
    board_id = board["id"]
    lanes = [item for item in state.get("lanes", []) if item.get("board_id") == board_id]
    cards = [item for item in state.get("cards", []) if item.get("board_id") == board_id]
    active_cards = [item for item in cards if not bool(item.get("archived", False))]
    timed_types = {"interval", "recurring", "deadline"}
    timed_count = sum(
        1 for item in active_cards
        if str(item.get("event_type") or "none").strip().lower() in timed_types
    )
    checklist_total = sum(len(item.get("checklist") or []) for item in active_cards)
    checklist_done = sum(
        sum(1 for check in item.get("checklist") or [] if check.get("done"))
        for item in active_cards
    )
    return {
        **board,
        "lane_count": len(lanes),
        "card_count": len(active_cards),
        "card_total_count": len(cards),
        "archived_card_count": len(cards) - len(active_cards),
        "timed_card_count": timed_count,
        "checklist_total": checklist_total,
        "checklist_done": checklist_done,
    }


def list_boards() -> list[dict]:
    state = load_state()
    boards = state.get("boards", [])
    summaries = [_board_summary(state, item) for item in boards]
    return sorted(summaries, key=lambda item: (item.get("updated_at", ""), item.get("title", "").lower()), reverse=True)


def _matches_recurring_on_day(card: dict, target_day: str) -> bool:
    target = date.fromisoformat(target_day)
    anchor_text = str(card.get("date") or "").strip()
    until_text = str(card.get("repeat_end_date") or "").strip()
    if anchor_text:
        anchor = date.fromisoformat(anchor_text)
        if target < anchor:
            return False
    if until_text:
        until = date.fromisoformat(until_text)
        if target > until:
            return False
    rule = str(card.get("repeat_rule") or "none").strip().lower()
    if rule == "daily":
        return True
    if rule != "weekly":
        return False

    weekdays = _normalize_weekdays(card.get("repeat_weekdays"))
    if not weekdays and anchor_text:
        weekdays = [WEEKDAY_KEYS[date.fromisoformat(anchor_text).weekday()]]
    if not weekdays:
        return False
    return WEEKDAY_KEYS[target.weekday()] in weekdays


def _minutes_to_display_time(value: int) -> str:
    if value >= 24 * 60:
        return "24:00"
    return _minutes_to_time(value)


def _card_starts_on_day(card: dict, event_type: str, target_day: str) -> bool:
    if event_type in {"interval", "deadline"}:
        return str(card.get("date") or "").strip() == target_day
    if event_type == "recurring":
        return _matches_recurring_on_day(card, target_day)
    return False


def _build_timeline_segments_for_day(card: dict, event_type: str, target_day: str) -> list[dict]:
    start_text = str(card.get("start_time") or "").strip()
    end_text = str(card.get("end_time") or "").strip()
    if event_type == "deadline":
        start_text, end_text = _resolve_deadline_window(start_text, end_text)
    start_minutes = _parse_time_minutes(start_text)
    end_minutes = _parse_time_minutes(end_text)
    if start_minutes is None or end_minutes is None or start_minutes == end_minutes:
        return []

    spans_next_day = end_minutes < start_minutes
    segments: list[dict] = []

    if _card_starts_on_day(card, event_type, target_day):
        segments.append({
            "source_day": target_day,
            "start_minutes": start_minutes,
            "end_minutes": 24 * 60 if spans_next_day else end_minutes,
            "from_previous_day": False,
        })

    if spans_next_day:
        previous_day = (date.fromisoformat(target_day) - timedelta(days=1)).isoformat()
        if _card_starts_on_day(card, event_type, previous_day):
            segments.append({
                "source_day": previous_day,
                "start_minutes": 0,
                "end_minutes": end_minutes,
                "from_previous_day": True,
            })

    return segments


def _build_timeline(cards: list[dict], lanes_by_id: dict[str, dict], target_day: str) -> list[dict]:
    timeline = []
    for card in cards:
        event_type = _normalize_event_type(card.get("event_type"))
        if event_type == "none":
            continue

        segments = _build_timeline_segments_for_day(card, event_type, target_day)
        if not segments:
            continue

        lane = lanes_by_id.get(card.get("lane_id", ""))
        for segment_index, segment in enumerate(segments):
            timeline.append({
                "id": card["id"],
                "title": card["title"],
                "lane_id": card.get("lane_id", ""),
                "lane_title": lane.get("title", "") if lane else "",
                "color": card.get("color", "slate"),
                "event_type": event_type,
                "date": target_day,
                "occurrence_date": segment["source_day"],
                "continuation": bool(segment["from_previous_day"]),
                "segment_index": segment_index,
                "start_time": _minutes_to_display_time(segment["start_minutes"]),
                "end_time": _minutes_to_display_time(segment["end_minutes"]),
                "start_minutes": segment["start_minutes"],
                "end_minutes": segment["end_minutes"],
                "labels": card.get("labels", []),
                "members": card.get("members", []),
                "due_date": card.get("due_date", ""),
                "repeat_end_date": card.get("repeat_end_date", ""),
                "repeat_rule": card.get("repeat_rule", "none"),
            })

    timeline.sort(
        key=lambda item: (
            item["start_minutes"],
            item["end_minutes"],
            item["title"].lower(),
            item.get("occurrence_date", ""),
            item["id"],
        )
    )
    return timeline


def get_board_view(board_id: str, target_day: str | None = None, include_archived: bool = False) -> dict | None:
    state = load_state()
    board = _find_board(state, board_id)
    if board is None:
        return None

    safe_day = _normalize_date_text(target_day) if target_day else date.today().isoformat()
    lanes = _sorted_board_lanes(state, board_id)
    cards = [item for item in state.get("cards", []) if item.get("board_id") == board_id]
    if not include_archived:
        cards = [item for item in cards if not bool(item.get("archived", False))]
    cards.sort(key=lambda item: (item.get("lane_id", ""), int(item.get("position", POSITION_STEP)), item.get("updated_at", ""), item.get("id", "")))

    lanes_by_id = {item["id"]: item for item in lanes}
    cards_by_lane: dict[str, list[dict]] = {item["id"]: [] for item in lanes}
    for card in cards:
        lane_id = card.get("lane_id")
        if lane_id in cards_by_lane:
            checklist = card.get("checklist") or []
            done_count = sum(1 for item in checklist if item.get("done"))
            cards_by_lane[lane_id].append({
                **card,
                "checklist_total": len(checklist),
                "checklist_done": done_count,
            })

    lane_payloads = [{**lane, "cards": cards_by_lane.get(lane["id"], [])} for lane in lanes]
    timeline_events = _build_timeline(cards, lanes_by_id, safe_day)
    summary = _board_summary(state, board)

    return {
        "board": summary,
        "day": safe_day,
        "include_archived": bool(include_archived),
        "lanes": lane_payloads,
        "timeline_events": timeline_events,
    }


def create_board(payload: dict) -> dict:
    title = str(payload.get("title") or "").strip()
    if not title:
        raise CalendarValidationError("看板标题不能为空。", status_code=422)

    board_id = str(payload.get("id") or uuid4())
    lane_ids = [str(uuid4()), str(uuid4()), str(uuid4())]
    now = _utc_timestamp()

    def mutator(state: dict) -> tuple[str, bool]:
        state.setdefault("boards", []).append({
            "id": board_id,
            "title": title[:120],
            "description": str(payload.get("description") or "").strip()[:2000],
            "color": _normalize_color(payload.get("color"), "slate"),
            "created_at": now,
            "updated_at": now,
        })
        state.setdefault("lanes", []).extend([
            {
                "id": lane_ids[0],
                "board_id": board_id,
                "title": "Backlog",
                "position": POSITION_STEP,
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": lane_ids[1],
                "board_id": board_id,
                "title": "Doing",
                "position": POSITION_STEP * 2,
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": lane_ids[2],
                "board_id": board_id,
                "title": "Done",
                "position": POSITION_STEP * 3,
                "created_at": now,
                "updated_at": now,
            },
        ])
        return board_id, True

    created_id, saved = mutate_state(mutator)
    board = next((item for item in saved.get("boards", []) if item["id"] == created_id), None)
    return _board_summary(saved, board) if board else {"id": created_id, "title": title}


def update_board(board_id: str, payload: dict) -> dict | None:
    def mutator(state: dict) -> tuple[str | None, bool]:
        board = _find_board(state, board_id)
        if board is None:
            return None, False

        if "title" in payload:
            title = str(payload.get("title") or "").strip()
            if not title:
                raise CalendarValidationError("看板标题不能为空。", status_code=422)
            board["title"] = title[:120]
        if "description" in payload:
            board["description"] = str(payload.get("description") or "").strip()[:2000]
        if "color" in payload:
            board["color"] = _normalize_color(payload.get("color"), "slate")
        board["updated_at"] = _utc_timestamp()
        return board_id, True

    updated_id, saved = mutate_state(mutator)
    if updated_id is None:
        return None
    board = next((item for item in saved.get("boards", []) if item["id"] == updated_id), None)
    return _board_summary(saved, board) if board else None


def delete_board(board_id: str) -> bool:
    def mutator(state: dict) -> tuple[bool, bool]:
        boards = state.setdefault("boards", [])
        if not any(item["id"] == board_id for item in boards):
            return False, False

        state["boards"] = [item for item in boards if item["id"] != board_id]
        lane_ids = {item["id"] for item in state.get("lanes", []) if item.get("board_id") == board_id}
        state["lanes"] = [item for item in state.get("lanes", []) if item.get("board_id") != board_id]
        state["cards"] = [
            item for item in state.get("cards", [])
            if item.get("board_id") != board_id and item.get("lane_id") not in lane_ids
        ]
        return True, True

    deleted, _ = mutate_state(mutator)
    return bool(deleted)


def create_lane(payload: dict) -> dict:
    board_id = str(payload.get("board_id") or "").strip()
    title = str(payload.get("title") or "").strip()
    if not board_id:
        raise CalendarValidationError("board_id 不能为空。", status_code=422)
    if not title:
        raise CalendarValidationError("列表标题不能为空。", status_code=422)

    lane_id = str(payload.get("id") or uuid4())
    target_index = payload.get("position")
    now = _utc_timestamp()

    def mutator(state: dict) -> tuple[str, bool]:
        board = _find_board(state, board_id)
        if board is None:
            raise CalendarValidationError("看板不存在。", status_code=404)

        state.setdefault("lanes", []).append({
            "id": lane_id,
            "board_id": board_id,
            "title": title[:80],
            "position": POSITION_STEP * 999,
            "created_at": now,
            "updated_at": now,
        })
        _resequence_lanes(state, board_id, moving_lane_id=lane_id, target_index=target_index)
        _touch_board(state, board_id)
        return lane_id, True

    created_id, saved = mutate_state(mutator)
    lane = next((item for item in saved.get("lanes", []) if item["id"] == created_id), None)
    return lane or {"id": created_id, "board_id": board_id, "title": title}


def update_lane(lane_id: str, payload: dict) -> dict | None:
    def mutator(state: dict) -> tuple[str | None, bool]:
        lane = _find_lane(state, lane_id)
        if lane is None:
            return None, False

        board_id = lane["board_id"]
        if "title" in payload:
            title = str(payload.get("title") or "").strip()
            if not title:
                raise CalendarValidationError("列表标题不能为空。", status_code=422)
            lane["title"] = title[:80]
        if "position" in payload:
            _resequence_lanes(state, board_id, moving_lane_id=lane_id, target_index=payload.get("position"))
        else:
            lane["updated_at"] = _utc_timestamp()
        _touch_board(state, board_id)
        return lane_id, True

    updated_id, saved = mutate_state(mutator)
    if updated_id is None:
        return None
    return next((item for item in saved.get("lanes", []) if item["id"] == updated_id), None)


def delete_lane(lane_id: str) -> bool:
    def mutator(state: dict) -> tuple[bool, bool]:
        lane = _find_lane(state, lane_id)
        if lane is None:
            return False, False

        board_id = lane["board_id"]
        remaining_lanes = [item for item in state.get("lanes", []) if item["board_id"] == board_id and item["id"] != lane_id]
        if not remaining_lanes:
            fallback_lane_id = str(uuid4())
            state.setdefault("lanes", []).append({
                "id": fallback_lane_id,
                "board_id": board_id,
                "title": "To Do",
                "position": POSITION_STEP,
                "created_at": _utc_timestamp(),
                "updated_at": _utc_timestamp(),
            })
            remaining_lanes = [item for item in state.get("lanes", []) if item["id"] == fallback_lane_id]

        target_lane = sorted(
            remaining_lanes,
            key=lambda item: (int(item.get("position", POSITION_STEP)), item.get("created_at", ""), item.get("id", "")),
        )[0]

        for card in state.get("cards", []):
            if card.get("lane_id") == lane_id:
                card["lane_id"] = target_lane["id"]
                card["board_id"] = board_id
                card["updated_at"] = _utc_timestamp()

        state["lanes"] = [item for item in state.get("lanes", []) if item["id"] != lane_id]
        _resequence_lanes(state, board_id)
        _resequence_cards(state, target_lane["id"])
        _touch_board(state, board_id)
        return True, True

    deleted, _ = mutate_state(mutator)
    return bool(deleted)


def set_lane_cards_archived(lane_id: str, archived: bool = True) -> dict | None:
    def mutator(state: dict) -> tuple[dict | None, bool]:
        lane = _find_lane(state, lane_id)
        if lane is None:
            return None, False

        board_id = lane["board_id"]
        now = _utc_timestamp()
        changed = 0
        total = 0
        for card in state.get("cards", []):
            if card.get("lane_id") != lane_id:
                continue
            total += 1
            is_archived = bool(card.get("archived", False))
            if is_archived == bool(archived):
                continue
            card["archived"] = bool(archived)
            card["archived_at"] = now if archived else ""
            card["updated_at"] = now
            changed += 1

        if changed > 0:
            _touch_board(state, board_id)

        return {
            "lane_id": lane_id,
            "board_id": board_id,
            "archived": bool(archived),
            "changed_count": changed,
            "total_count": total,
        }, changed > 0

    payload, _ = mutate_state(mutator)
    return payload


def create_card(payload: dict) -> dict:
    board_id = str(payload.get("board_id") or "").strip()
    lane_id = str(payload.get("lane_id") or "").strip()
    title = str(payload.get("title") or "").strip()
    if not board_id:
        raise CalendarValidationError("board_id 不能为空。", status_code=422)
    if not lane_id:
        raise CalendarValidationError("lane_id 不能为空。", status_code=422)
    if not title:
        raise CalendarValidationError("卡片标题不能为空。", status_code=422)

    card_id = str(payload.get("id") or uuid4())
    target_index = payload.get("position")
    now = _utc_timestamp()

    def mutator(state: dict) -> tuple[str, bool]:
        board = _find_board(state, board_id)
        if board is None:
            raise CalendarValidationError("看板不存在。", status_code=404)
        lane = _find_lane(state, lane_id)
        if lane is None or lane.get("board_id") != board_id:
            raise CalendarValidationError("目标列表不存在或不属于该看板。", status_code=404)

        card = {
            "id": card_id,
            "board_id": board_id,
            "lane_id": lane_id,
            "title": title[:160],
            "description": str(payload.get("description") or "").strip()[:4000],
            "labels": _normalize_short_list(payload.get("labels"), max_items=10, max_length=24),
            "members": _normalize_short_list(payload.get("members"), max_items=12, max_length=24),
            "checklist": _normalize_checklist(payload.get("checklist")),
            "position": POSITION_STEP * 999,
            "due_date": _normalize_date_text(payload.get("due_date")),
            "color": _normalize_color(payload.get("color"), "slate"),
            "event_type": _normalize_event_type(payload.get("event_type")),
            "date": _normalize_date_text(payload.get("date")),
            "repeat_end_date": _normalize_date_text(payload.get("repeat_end_date")),
            "start_time": _normalize_time_text(payload.get("start_time")),
            "end_time": _normalize_time_text(payload.get("end_time")),
            "repeat_rule": _normalize_repeat_rule(payload.get("repeat_rule")),
            "repeat_weekdays": _normalize_weekdays(payload.get("repeat_weekdays")),
            "archived": bool(payload.get("archived", False)),
            "archived_at": _utc_timestamp() if bool(payload.get("archived", False)) else "",
            "created_at": now,
            "updated_at": now,
        }
        event_type = _normalize_event_type(card.get("event_type"))
        card["event_type"] = event_type
        if event_type == "none":
            card["date"] = ""
            card["repeat_end_date"] = ""
            card["start_time"] = ""
            card["end_time"] = ""
            card["repeat_rule"] = "none"
            card["repeat_weekdays"] = []
        elif event_type == "deadline":
            card["repeat_end_date"] = ""
            card["repeat_rule"] = "none"
            card["repeat_weekdays"] = []
            deadline_start, deadline_end = _resolve_deadline_window(card.get("start_time"), card.get("end_time"))
            card["start_time"] = deadline_start
            card["end_time"] = deadline_end
            if not card.get("due_date") and card.get("date"):
                card["due_date"] = card.get("date", "")
        elif event_type == "interval":
            card["repeat_end_date"] = ""
            card["repeat_rule"] = "none"
            card["repeat_weekdays"] = []
        elif event_type == "recurring":
            if card.get("repeat_rule") not in {"daily", "weekly"}:
                card["repeat_rule"] = "weekly"
            if card.get("repeat_rule") == "weekly" and not card.get("repeat_weekdays"):
                anchor_date = str(card.get("date") or "").strip()
                if anchor_date:
                    weekday = WEEKDAY_KEYS[date.fromisoformat(anchor_date).weekday()]
                    card["repeat_weekdays"] = [weekday]
        _validate_card_event_payload(card)

        state.setdefault("cards", []).append(card)
        _resequence_cards(state, lane_id, moving_card_id=card_id, target_index=target_index)
        _touch_board(state, board_id)
        return card_id, True

    created_id, saved = mutate_state(mutator)
    return next((item for item in saved.get("cards", []) if item["id"] == created_id), {"id": created_id, "title": title})


def update_card(card_id: str, payload: dict) -> dict | None:
    def mutator(state: dict) -> tuple[str | None, bool]:
        card = _find_card(state, card_id)
        if card is None:
            return None, False

        old_lane_id, old_board_id = _apply_card_patch(card, payload, state)
        target_index = _resolve_card_target_index(
            state,
            card["lane_id"],
            card_id,
            position=payload.get("position"),
            before_card_id=payload.get("before_card_id"),
            after_card_id=payload.get("after_card_id"),
        )
        _resequence_cards(state, old_lane_id)
        _resequence_cards(state, card["lane_id"], moving_card_id=card_id, target_index=target_index)
        _touch_board(state, old_board_id)
        _touch_board(state, card["board_id"])
        return card_id, True

    updated_id, saved = mutate_state(mutator)
    if updated_id is None:
        return None
    return next((item for item in saved.get("cards", []) if item["id"] == updated_id), None)


def move_card(
    card_id: str,
    lane_id: str,
    position: int | None = None,
    before_card_id: str | None = None,
    after_card_id: str | None = None,
) -> dict | None:
    payload = {"lane_id": lane_id}
    if position is not None:
        payload["position"] = position
    if before_card_id:
        payload["before_card_id"] = before_card_id
    if after_card_id:
        payload["after_card_id"] = after_card_id
    return update_card(card_id, payload)


def delete_card(card_id: str) -> bool:
    def mutator(state: dict) -> tuple[bool, bool]:
        card = _find_card(state, card_id)
        if card is None:
            return False, False

        lane_id = card["lane_id"]
        board_id = card["board_id"]
        state["cards"] = [item for item in state.get("cards", []) if item["id"] != card_id]
        _resequence_cards(state, lane_id)
        _touch_board(state, board_id)
        return True, True

    deleted, _ = mutate_state(mutator)
    return bool(deleted)


def move_lane(lane_id: str, position: int) -> dict | None:
    return update_lane(lane_id, {"position": position})
