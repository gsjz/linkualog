from collections.abc import Callable
from typing import TypeVar

from fastapi import HTTPException

from core.calendar import CalendarValidationError

T = TypeVar("T")


def run_calendar_action(action: Callable[[], T]) -> T:
    try:
        return action()
    except CalendarValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
