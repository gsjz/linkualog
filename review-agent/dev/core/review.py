from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta


@dataclass
class SM2State:
    easiness: float = 2.5
    interval_days: int = 0
    repetitions: int = 0


def clamp_score(raw_score: int) -> int:
    score = int(raw_score)
    if score < 0:
        return 0
    if score > 5:
        return 5
    return score


def parse_review_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def format_review_date(value: date) -> str:
    return value.strftime("%Y-%m-%d")


def _sorted_reviews(reviews: list[dict]) -> list[dict]:
    def _key(item: dict) -> tuple[date, int]:
        d = parse_review_date(item.get("date", "1970-01-01"))
        s = clamp_score(item.get("score", 0))
        return d, s

    normalized = []
    for item in reviews or []:
        if not isinstance(item, dict):
            continue
        raw_date = item.get("date")
        raw_score = item.get("score")
        if raw_date is None or raw_score is None:
            continue
        try:
            parsed_date = parse_review_date(str(raw_date))
            parsed_score = clamp_score(raw_score)
        except Exception:
            continue
        normalized.append({"date": format_review_date(parsed_date), "score": parsed_score})

    normalized.sort(key=_key)
    return normalized


def replay_sm2(reviews: list[dict]) -> tuple[SM2State, date | None]:
    state = SM2State()
    last_date = None

    for review in _sorted_reviews(reviews):
        review_date = parse_review_date(review["date"])
        quality = clamp_score(review["score"])

        if quality < 3:
            state.repetitions = 0
            state.interval_days = 1
        else:
            state.repetitions += 1
            if state.repetitions == 1:
                state.interval_days = 1
            elif state.repetitions == 2:
                state.interval_days = 6
            else:
                state.interval_days = max(1, round(state.interval_days * state.easiness))

        delta = 5 - quality
        state.easiness = max(1.3, state.easiness + (0.1 - delta * (0.08 + delta * 0.02)))
        last_date = review_date

    return state, last_date


def build_review_advice(reviews: list[dict], today: date | None = None) -> dict:
    today = today or date.today()
    sorted_reviews = _sorted_reviews(reviews)

    if not sorted_reviews:
        return {
            "status": "new",
            "next_review_date": format_review_date(today),
            "days_until_due": 0,
            "message": "新词条，建议今天先复习并打分。",
            "sm2": {
                "easiness": 2.5,
                "interval_days": 0,
                "repetitions": 0,
            },
            "review_count": 0,
        }

    state, last_date = replay_sm2(sorted_reviews)
    assert last_date is not None

    next_review_date = last_date + timedelta(days=state.interval_days)
    days_until_due = (next_review_date - today).days

    if days_until_due < 0:
        status = "overdue"
        message = f"已逾期 {-days_until_due} 天，建议立即复习。"
    elif days_until_due == 0:
        status = "due_today"
        message = "今天到期，建议现在复习。"
    elif days_until_due <= 2:
        status = "due_soon"
        message = f"{days_until_due} 天后到期，可提前预习。"
    else:
        status = "scheduled"
        message = f"距离下次复习还有 {days_until_due} 天。"

    return {
        "status": status,
        "next_review_date": format_review_date(next_review_date),
        "days_until_due": days_until_due,
        "message": message,
        "sm2": {
            "easiness": round(state.easiness, 3),
            "interval_days": state.interval_days,
            "repetitions": state.repetitions,
        },
        "review_count": len(sorted_reviews),
        "last_review": sorted_reviews[-1],
    }


def append_or_replace_today_review(reviews: list[dict], score: int, review_day: date) -> list[dict]:
    normalized = _sorted_reviews(reviews)
    entry = {
        "date": format_review_date(review_day),
        "score": clamp_score(score),
    }

    if normalized and normalized[-1].get("date") == entry["date"]:
        normalized[-1] = entry
    else:
        normalized.append(entry)

    return normalized
