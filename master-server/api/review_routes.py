import logging
import os
import re
from copy import deepcopy
from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.config import get_config_data
from core.review import (
    append_or_replace_today_review,
    build_review_advice,
    clamp_score,
    format_review_date,
    parse_review_date,
)
from core.review_vocabulary import (
    list_categories,
    list_vocab_files,
    load_vocab_entry,
    load_vocab_file,
    resolve_vocab_file_for_write,
    save_vocab_file,
)
from services.analysis import (
    analyze_file_cleaning_suggestions,
    analyze_folder_merge_suggestions,
)
from services.lemma_dictionary import get_lemma_words
from services.review_llm import (
    get_dictionary_merge_target_candidates,
    suggest_entry_quality_with_rules,
    suggest_file_cleaning_with_llm,
    suggest_folder_merge_with_llm,
    suggest_missing_definitions_with_llm,
    suggest_missing_example_explanations_with_llm,
)

router = APIRouter()
_WS_RE = re.compile(r"\s+")
logger = logging.getLogger("master_server.review.api")

_DEFAULT_RECOMMENDATION_PREFERENCES = {
    "due_weight": 2.2,
    "created_weight": 0.35,
    "score_weight": 0.75,
    "created_order": "recent",
    "score_order": "low",
}
_RECOMMENDATION_CREATED_ORDERS = {"recent", "oldest"}
_RECOMMENDATION_SCORE_ORDERS = {"low", "high"}
_RECOMMENDATION_CREATED_AGE_WINDOW_DAYS = 120
_RECOMMENDATION_CONFIG_KEYS = {
    "due_weight": "review_recommend_due_weight",
    "created_weight": "review_recommend_created_weight",
    "score_weight": "review_recommend_score_weight",
    "created_order": "review_recommend_created_order",
    "score_order": "review_recommend_score_order",
}


class FolderRefineRequest(BaseModel):
    category: str
    include_low_confidence: bool = False
    include_llm: bool = True


class FileRefineRequest(BaseModel):
    category: str
    filename: str
    include_llm: bool = True
    data: dict | None = None


class ReviewSuggestRequest(BaseModel):
    category: str
    filename: str
    score: int | None = None
    review_date: str | None = None
    auto_save: bool = True


class ReviewRecommendRequest(BaseModel):
    category: str | None = None
    exclude_keys: list[str] = []
    limit: int = 5
    due_weight: float | None = None
    created_weight: float | None = None
    score_weight: float | None = None
    created_order: str | None = None
    score_order: str | None = None


class VocabSaveRequest(BaseModel):
    category: str
    filename: str
    data: dict


class VocabRenameRequest(BaseModel):
    category: str
    filename: str
    word: str
    data: dict | None = None


class MergeApplyRequest(BaseModel):
    category: str
    source_filename: str
    target_filename: str
    delete_source: bool = False
    create_target_if_missing: bool = False


class SplitApplyRequest(BaseModel):
    category: str
    source_filename: str
    suggestion: dict
    delete_source: bool = True
    data: dict | None = None


def _normalize_text_key(value: str) -> str:
    text = _WS_RE.sub(" ", str(value or "")).strip().lower()
    return text.replace("’", "'").replace("`", "'")


def _normalize_definition_key(value: str) -> str:
    normalized = _normalize_text_key(value)
    return re.sub(r"[\W_]+", "", normalized, flags=re.UNICODE)


def _normalize_json_filename(filename: str) -> str:
    name = str(filename or "").strip()
    if not name:
        return ""
    if not name.endswith(".json"):
        name = f"{name}.json"
    return os.path.basename(name)


def _normalize_vocab_word(word: str) -> str:
    text = _WS_RE.sub(" ", str(word or "")).strip().lower()
    text = re.sub(r"\.json$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[\s_]+", "-", text)
    return text.strip("-")


def _build_vocab_filename(word: str) -> str:
    normalized = _normalize_vocab_word(word)
    if not normalized:
        raise ValueError("word 不能为空")
    return _normalize_json_filename(normalized)


def _safe_created_at(raw_value: str | None) -> str:
    value = str(raw_value or "").strip()
    try:
        return format_review_date(parse_review_date(value))
    except Exception:
        return ""


def _require_category(category: str) -> str:
    normalized = str(category or "").strip()
    if not normalized:
        raise ValueError("保存目录不能为空，必须使用 data/文件夹/")
    return normalized


def _build_recommendation_reason(advice: dict, last_review: dict | None) -> str:
    status = str(advice.get("status") or "")
    days_until_due = int(advice.get("days_until_due") or 0)
    review_count = int(advice.get("review_count") or 0)
    next_review_date = str(advice.get("next_review_date") or "")

    if status == "overdue":
        base = f"已逾期 {-days_until_due} 天，应该优先复习。"
    elif status == "due_today":
        base = "今天到期，适合现在复习。"
    elif status == "new":
        base = "还是新词条，建议尽快完成首次复习。"
    elif status == "due_soon":
        base = f"{days_until_due} 天后到期，适合提前过一遍。"
    else:
        base = f"下次计划复习时间是 {next_review_date}。"

    if last_review:
        return f"{base} 最近一次打分 {last_review.get('score', 0)}，累计复习 {review_count} 次。"
    if review_count:
        return f"{base} 累计复习 {review_count} 次。"
    return base


def _clamp_recommendation_weight(value, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    if number < 0:
        return 0.0
    if number > 5:
        return 5.0
    return round(number, 3)


def _normalize_recommendation_choice(value, allowed: set[str], fallback: str, field_name: str) -> str:
    choice = str(value or fallback).strip().lower()
    if choice not in allowed:
        options = ", ".join(sorted(allowed))
        raise ValueError(f"{field_name} 只能是 {options}")
    return choice


def _normalize_recommendation_preferences(req: ReviewRecommendRequest) -> dict:
    server_config = get_config_data()
    defaults = {
        key: server_config.get(config_key, fallback)
        for key, config_key in _RECOMMENDATION_CONFIG_KEYS.items()
        for fallback in [_DEFAULT_RECOMMENDATION_PREFERENCES[key]]
    }
    return {
        "due_weight": _clamp_recommendation_weight(
            req.due_weight,
            defaults["due_weight"],
        ),
        "created_weight": _clamp_recommendation_weight(
            req.created_weight,
            defaults["created_weight"],
        ),
        "score_weight": _clamp_recommendation_weight(
            req.score_weight,
            defaults["score_weight"],
        ),
        "created_order": _normalize_recommendation_choice(
            req.created_order,
            _RECOMMENDATION_CREATED_ORDERS,
            defaults["created_order"],
            "created_order",
        ),
        "score_order": _normalize_recommendation_choice(
            req.score_order,
            _RECOMMENDATION_SCORE_ORDERS,
            defaults["score_order"],
            "score_order",
        ),
    }


def _created_age_days(created_at: str, today: date) -> int | None:
    created_day = _safe_created_at(created_at)
    if not created_day:
        return None
    try:
        return max(0, (today - parse_review_date(created_day)).days)
    except Exception:
        return None


def _due_priority_component(advice: dict) -> float:
    status = str(advice.get("status") or "")
    days_until_due = int(advice.get("days_until_due") or 0)

    if status == "overdue":
        return 100.0
    if status == "due_today":
        return 95.0
    if status == "new":
        return 88.0
    if status == "due_soon":
        return max(72.0, 90.0 - max(0, days_until_due) * 9.0)
    if status == "scheduled":
        return max(0.0, 55.0 - min(max(0, days_until_due), 55))
    return 0.0


def _created_priority_component(created_at: str, today: date, order: str) -> tuple[float, int | None]:
    age_days = _created_age_days(created_at, today)
    if age_days is None:
        return 50.0, None

    age_score = min(age_days, _RECOMMENDATION_CREATED_AGE_WINDOW_DAYS) / _RECOMMENDATION_CREATED_AGE_WINDOW_DAYS * 100.0
    if order == "oldest":
        component = age_score
    else:
        component = 100.0 - age_score
    return round(component, 3), age_days


def _review_score_priority_component(advice: dict, order: str) -> tuple[float, int | None]:
    last_review = advice.get("last_review") if isinstance(advice.get("last_review"), dict) else None
    if not last_review:
        return (100.0 if order == "low" else 0.0), None

    last_score = clamp_score(last_review.get("score", 0))
    if order == "high":
        component = last_score / 5.0 * 100.0
    else:
        component = (5 - last_score) / 5.0 * 100.0
    return round(component, 3), last_score


def _build_review_candidate_score(advice: dict, created_at: str, today: date, preferences: dict) -> dict:
    due_component = round(_due_priority_component(advice), 3)
    created_component, created_age_days = _created_priority_component(
        created_at,
        today,
        str(preferences.get("created_order") or _DEFAULT_RECOMMENDATION_PREFERENCES["created_order"]),
    )
    score_component, last_score = _review_score_priority_component(
        advice,
        str(preferences.get("score_order") or _DEFAULT_RECOMMENDATION_PREFERENCES["score_order"]),
    )

    due_weight = float(preferences.get("due_weight", _DEFAULT_RECOMMENDATION_PREFERENCES["due_weight"]))
    created_weight = float(preferences.get("created_weight", _DEFAULT_RECOMMENDATION_PREFERENCES["created_weight"]))
    score_weight = float(preferences.get("score_weight", _DEFAULT_RECOMMENDATION_PREFERENCES["score_weight"]))

    weighted = {
        "due": round(due_component * due_weight, 3),
        "created": round(created_component * created_weight, 3),
        "score": round(score_component * score_weight, 3),
    }
    priority_score = round(sum(weighted.values()), 3)

    return {
        "priority_score": priority_score,
        "score_breakdown": {
            "components": {
                "due": due_component,
                "created": created_component,
                "score": score_component,
            },
            "weighted": weighted,
            "weights": {
                "due": due_weight,
                "created": created_weight,
                "score": score_weight,
            },
            "directions": {
                "created": preferences.get("created_order"),
                "score": preferences.get("score_order"),
            },
            "created_age_days": created_age_days,
            "last_score": last_score,
            "has_review": last_score is not None,
        },
    }


def _score_review_candidate(advice: dict, created_at: str, today: date) -> float:
    return _build_review_candidate_score(
        advice,
        created_at,
        today,
        _DEFAULT_RECOMMENDATION_PREFERENCES,
    )["priority_score"]


def _clamp_probability(value, fallback: float = 0.66) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number < 0:
        return 0.0
    if number > 1:
        return 1.0
    return number


def _confidence_level(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.65:
        return "medium"
    return "low"


def _safe_reviews(raw_reviews) -> list[dict]:
    if not isinstance(raw_reviews, list):
        return []

    merged_by_date = {}
    for item in raw_reviews:
        if not isinstance(item, dict):
            continue

        raw_date = item.get("date")
        raw_score = item.get("score")
        if raw_date is None or raw_score is None:
            continue

        try:
            final_date = format_review_date(parse_review_date(str(raw_date)))
            final_score = clamp_score(raw_score)
        except Exception:
            continue

        existing = merged_by_date.get(final_date)
        if existing is None or final_score > existing["score"]:
            merged_by_date[final_date] = {"date": final_date, "score": final_score}

    return [merged_by_date[key] for key in sorted(merged_by_date.keys())]


def _safe_definitions(raw_definitions) -> list[str]:
    if not isinstance(raw_definitions, list):
        return []

    final = []
    seen = set()
    for item in raw_definitions:
        text = str(item or "").strip()
        if not text:
            continue
        key = _normalize_definition_key(text)
        if key in seen:
            continue
        seen.add(key)
        final.append(text)
    return final


def _safe_focus_positions(raw_positions, token_count: int | None = None) -> list[int]:
    if not isinstance(raw_positions, list):
        return []

    values = []
    seen = set()
    for item in raw_positions:
        try:
            value = int(item)
        except (TypeError, ValueError):
            continue
        if value < 0 or value in seen:
            continue
        if token_count is not None and value >= token_count:
            continue
        seen.add(value)
        values.append(value)
    values.sort()
    return values


def _safe_examples(raw_examples) -> list[dict]:
    if not isinstance(raw_examples, list):
        return []

    result = []
    seen_text = {}
    for item in raw_examples:
        if not isinstance(item, dict):
            continue

        entry = deepcopy(item)
        entry["text"] = str(entry.get("text", ""))
        entry["explanation"] = str(entry.get("explanation", ""))

        focus_words = entry.get("focusWords")
        if isinstance(focus_words, list):
            entry["focusWords"] = [str(word).strip() for word in focus_words if str(word).strip()]
        else:
            entry["focusWords"] = []

        token_count = len(
            [
                token
                for token in re.findall(r"\s+|[\w]+|[^\w\s]", entry["text"], flags=re.UNICODE)
                if not token.isspace()
            ]
        )
        focus_positions = entry.get("focusPositions", entry.get("focusPosition", entry.get("fp", entry.get("fps"))))
        cleaned_focus_positions = _safe_focus_positions(focus_positions, token_count=token_count)
        if cleaned_focus_positions:
            entry["focusPositions"] = cleaned_focus_positions
        else:
            entry.pop("focusPositions", None)
        entry.pop("focusPosition", None)
        entry.pop("fp", None)
        entry.pop("fps", None)

        key = _normalize_text_key(entry["text"])
        if not key:
            result.append(entry)
            continue

        existed_index = seen_text.get(key)
        if existed_index is None:
            seen_text[key] = len(result)
            result.append(entry)
            continue

        base = result[existed_index]
        if not base.get("explanation") and entry.get("explanation"):
            base["explanation"] = entry["explanation"]
        if not base.get("source") and entry.get("source"):
            base["source"] = entry["source"]
        if not base.get("youtube") and entry.get("youtube"):
            base["youtube"] = entry["youtube"]

        merged_focus_words = list(dict.fromkeys((base.get("focusWords") or []) + (entry.get("focusWords") or [])))
        base["focusWords"] = merged_focus_words
        merged_focus_positions = _safe_focus_positions((base.get("focusPositions") or []) + (entry.get("focusPositions") or []))
        if merged_focus_positions:
            base["focusPositions"] = merged_focus_positions

    return result


def _normalize_vocab_payload(raw_payload: dict, fallback_word: str, fallback_created_at: str = "") -> dict:
    payload = deepcopy(raw_payload) if isinstance(raw_payload, dict) else {}
    word = str(payload.get("word") or fallback_word).strip() or fallback_word

    created_at = str(payload.get("createdAt") or fallback_created_at).strip()
    if not created_at:
        created_at = format_review_date(date.today())

    payload.pop("pronunciation", None)
    payload["word"] = word
    payload["createdAt"] = created_at
    payload["reviews"] = _safe_reviews(payload.get("reviews"))
    payload["definitions"] = _safe_definitions(payload.get("definitions"))
    payload["examples"] = _safe_examples(payload.get("examples"))
    return payload


def _rewrite_vocab_word_references(payload: dict, source_words: set[str], target_word: str) -> dict:
    normalized_sources = {_normalize_vocab_word(item) for item in source_words if _normalize_vocab_word(item)}
    payload["word"] = target_word
    if not normalized_sources:
        return payload

    examples = payload.get("examples")
    if isinstance(examples, list):
        for example in examples:
            if not isinstance(example, dict):
                continue
            focus_words = example.get("focusWords")
            if not isinstance(focus_words, list):
                continue
            rewritten: list[str] = []
            for item in focus_words:
                text = str(item or "").strip()
                if not text:
                    continue
                if _normalize_vocab_word(text) in normalized_sources:
                    text = target_word
                if text not in rewritten:
                    rewritten.append(text)
            example["focusWords"] = rewritten

    review_sessions = payload.get("reviewSessions")
    if isinstance(review_sessions, list):
        for session in review_sessions:
            if not isinstance(session, dict):
                continue
            raw_word = str(session.get("word") or "").strip()
            if _normalize_vocab_word(raw_word) in normalized_sources:
                session["word"] = target_word

    return payload


def _merge_vocab_payload(target_payload: dict, source_payload: dict, target_fallback_word: str) -> dict:
    target = _normalize_vocab_payload(target_payload, target_fallback_word)
    source = _normalize_vocab_payload(source_payload, str(source_payload.get("word") or ""))

    target["reviews"] = _safe_reviews((target.get("reviews") or []) + (source.get("reviews") or []))
    target["definitions"] = _safe_definitions((target.get("definitions") or []) + (source.get("definitions") or []))
    target["examples"] = _safe_examples((target.get("examples") or []) + (source.get("examples") or []))

    merged_from = target.get("mergedFrom")
    if not isinstance(merged_from, list):
        merged_from = []
    source_word = str(source.get("word", "")).strip()
    if source_word and source_word not in merged_from and source_word != target.get("word"):
        merged_from.append(source_word)
    if merged_from:
        target["mergedFrom"] = merged_from

    return target


def _normalize_split_apply_entries(raw_suggestion: dict) -> list[dict]:
    if not isinstance(raw_suggestion, dict):
        return []

    raw_entries = (
        raw_suggestion.get("suggested_entries")
        or raw_suggestion.get("entries")
        or raw_suggestion.get("split_entries")
    )
    if not isinstance(raw_entries, list):
        return []

    normalized: list[dict] = []
    seen_words = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue

        word = _WS_RE.sub(
            " ",
            str(raw_entry.get("word") or raw_entry.get("target_word") or raw_entry.get("headword") or ""),
        ).strip()
        if not word:
            continue

        word_key = _normalize_text_key(word)
        if word_key in seen_words:
            continue
        seen_words.add(word_key)

        raw_focus_words = raw_entry.get("focus_words", raw_entry.get("focusWords"))
        focus_words = [
            _WS_RE.sub(" ", str(item or "")).strip()
            for item in raw_focus_words
            if _WS_RE.sub(" ", str(item or "")).strip()
        ] if isinstance(raw_focus_words, list) else []
        if not focus_words:
            focus_words = [word]

        example_indices = []
        raw_indices = raw_entry.get("example_indices")
        if isinstance(raw_indices, list):
            for item in raw_indices:
                try:
                    index = int(item)
                except (TypeError, ValueError):
                    continue
                if index >= 0 and index not in example_indices:
                    example_indices.append(index)
        raw_index = raw_entry.get("example_index")
        if raw_index is not None:
            try:
                index = int(raw_index)
                if index >= 0 and index not in example_indices:
                    example_indices.append(index)
            except (TypeError, ValueError):
                pass
        example_indices.sort()

        normalized.append(
            {
                "word": word,
                "definitions": _safe_definitions(raw_entry.get("definitions")),
                "focus_words": focus_words,
                "example_indices": example_indices,
                "reason": str(raw_entry.get("reason") or "").strip(),
            }
        )

    return normalized[:4]


def _build_split_examples(source_examples: list[dict], split_entry: dict) -> list[dict]:
    indices = split_entry.get("example_indices") if isinstance(split_entry.get("example_indices"), list) else []
    if indices:
        selected = [
            source_examples[index]
            for index in indices
            if isinstance(index, int) and 0 <= index < len(source_examples)
        ]
    else:
        selected = source_examples

    focus_words = split_entry.get("focus_words") if isinstance(split_entry.get("focus_words"), list) else []
    if not focus_words:
        focus_words = [str(split_entry.get("word") or "").strip()]

    examples = []
    for raw_example in selected:
        if not isinstance(raw_example, dict):
            continue
        example = deepcopy(raw_example)
        example["focusWords"] = focus_words
        example.pop("focusPositions", None)
        example.pop("focusPosition", None)
        example.pop("fp", None)
        example.pop("fps", None)
        examples.append(example)
    return _safe_examples(examples)


def _merge_split_target_payload(
    target_payload: dict,
    addition_payload: dict,
    target_word: str,
    source_created_at: str,
) -> dict:
    target = _normalize_vocab_payload(
        target_payload,
        fallback_word=target_word,
        fallback_created_at=source_created_at,
    )
    addition = _normalize_vocab_payload(
        addition_payload,
        fallback_word=target_word,
        fallback_created_at=source_created_at,
    )

    target["definitions"] = _safe_definitions(
        (target.get("definitions") or []) + (addition.get("definitions") or [])
    )
    target["examples"] = _safe_examples(
        (target.get("examples") or []) + (addition.get("examples") or [])
    )

    split_from = target.get("splitFrom")
    if not isinstance(split_from, list):
        split_from = []
    addition_split_from = addition.get("splitFrom") if isinstance(addition.get("splitFrom"), list) else []
    for item in addition_split_from:
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("file") or "").strip(),
            str(item.get("word") or "").strip(),
            str(item.get("reason") or "").strip(),
        )
        existed = any(
            isinstance(existing, dict)
            and (
                str(existing.get("file") or "").strip(),
                str(existing.get("word") or "").strip(),
                str(existing.get("reason") or "").strip(),
            ) == key
            for existing in split_from
        )
        if not existed:
            split_from.append(item)
    if split_from:
        target["splitFrom"] = split_from

    return target


def _missing_explanation_indices(heuristic: dict, examples: list[dict]) -> list[int]:
    if not isinstance(heuristic, dict) or not isinstance(examples, list):
        return []

    indices = []
    seen = set()
    suggestions = heuristic.get("suggestions") if isinstance(heuristic.get("suggestions"), list) else []
    for item in suggestions:
        if not isinstance(item, dict) or item.get("type") != "example_missing_explanation":
            continue
        try:
            index = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        if index < 0 or index in seen or index >= len(examples):
            continue
        example = examples[index]
        if not isinstance(example, dict):
            continue
        if not str(example.get("text") or "").strip():
            continue
        if str(example.get("explanation") or "").strip():
            continue
        seen.add(index)
        indices.append(index)
    return indices


def _llm_explanation_suggestion_indices(llm: dict, target_indices: set[int]) -> set[int]:
    covered = set()
    if not isinstance(llm, dict) or not target_indices:
        return covered

    examples = llm.get("examples") if isinstance(llm.get("examples"), list) else []
    for item in examples:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        if index in target_indices and str(item.get("suggested_explanation") or "").strip():
            covered.add(index)
    return covered


def _merge_llm_example_suggestions(existing_items, additional_items) -> list[dict]:
    merged = []
    seen = set()

    for item in list(existing_items if isinstance(existing_items, list) else []) + list(
        additional_items if isinstance(additional_items, list) else []
    ):
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("action") or ""),
            str(item.get("index") if item.get("index") is not None else ""),
            str(item.get("suggested_text") or ""),
            str(item.get("suggested_explanation") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


@router.get("/api/health")
def health_check():
    return {"status": "ok"}


@router.post("/api/vocabulary/save")
def save_vocab(req: VocabSaveRequest):
    try:
        category = _require_category(req.category)
        path, existing = load_vocab_entry(category, req.filename)
        fallback_word = os.path.splitext(os.path.basename(path))[0]
        normalized = _normalize_vocab_payload(
            req.data,
            fallback_word=fallback_word,
            fallback_created_at=str(existing.get("createdAt", "")),
        )
        save_vocab_file(path, normalized)

        return {
            "status": "success",
            "category": category,
            "file": os.path.basename(path),
            "data": normalized,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/vocabulary/rename")
def rename_vocab(req: VocabRenameRequest):
    try:
        category = _require_category(req.category)
        source_path, existing = load_vocab_entry(category, req.filename)
        source_file = os.path.basename(source_path)
        source_word = str(existing.get("word") or os.path.splitext(source_file)[0]).strip() or os.path.splitext(source_file)[0]

        target_word = _normalize_vocab_word(req.word)
        if not target_word:
            raise ValueError("word 不能为空")
        target_filename = _build_vocab_filename(target_word)
        target_path = resolve_vocab_file_for_write(category, target_filename)
        same_target = os.path.abspath(target_path) == os.path.abspath(source_path)

        payload_source = req.data if isinstance(req.data, dict) else existing
        normalized = _normalize_vocab_payload(
            payload_source,
            fallback_word=target_word,
            fallback_created_at=str(existing.get("createdAt", "")),
        )
        normalized = _rewrite_vocab_word_references(
            normalized,
            source_words={
                source_word,
                os.path.splitext(source_file)[0],
                str(req.filename or ""),
            },
            target_word=target_word,
        )
        target_existed = bool(not same_target and os.path.exists(target_path))
        if target_existed:
            target_payload = load_vocab_file(target_path)
            normalized["word"] = source_word
            normalized = _merge_vocab_payload(
                target_payload=target_payload,
                source_payload=normalized,
                target_fallback_word=target_word,
            )
        save_vocab_file(target_path, normalized)

        if not same_target:
            try:
                os.remove(source_path)
            except FileNotFoundError:
                pass

        return {
            "status": "success",
            "category": category,
            "source_file": source_file,
            "file": os.path.basename(target_path),
            "target_file": os.path.basename(target_path),
            "word": target_word,
            "data": normalized,
            "target_existed": target_existed,
            "merged_to_existing": target_existed,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/refine/folder")
def refine_folder(req: FolderRefineRequest):
    try:
        category = _require_category(req.category)
        logger.info(
            "[refine_folder] start category=%s include_low_confidence=%s include_llm=%s",
            category,
            req.include_low_confidence,
            req.include_llm,
        )
        files = list_vocab_files(category)
        entries = []
        skipped = []

        for path in files:
            try:
                payload = load_vocab_file(path)
                entries.append((path, payload))
            except Exception as exc:
                skipped.append({"file": os.path.basename(path), "reason": str(exc)})
        logger.info(
            "[refine_folder] loaded files=%s entries=%s skipped=%s",
            len(files),
            len(entries),
            len(skipped),
        )

        result = analyze_folder_merge_suggestions(
            entries,
            include_low_confidence=req.include_low_confidence,
        )
        result_data = deepcopy(result)
        logger.info(
            "[refine_folder] heuristic done suggestion_count=%s",
            len(result_data.get("suggestions", []) if isinstance(result_data, dict) else []),
        )
        llm = None
        llm_error = None

        if req.include_llm:
            try:
                logger.info("[refine_folder] llm analyze start entries=%s", len(entries))
                llm = suggest_folder_merge_with_llm(
                    entries=entries,
                )
                logger.info(
                    "[refine_folder] llm analyze success llm_suggestion_count=%s",
                    len(llm.get("suggestions", []) if isinstance(llm, dict) else []),
                )

                entry_by_file = {}
                entry_by_word = {}
                ambiguous_word_keys = set()
                for path, payload in entries:
                    file_name = os.path.basename(path)
                    fallback_word = os.path.splitext(file_name)[0]
                    word = str(payload.get("word") or fallback_word).strip() or fallback_word
                    entry_by_file[file_name] = {"word": word}
                    word_key = _normalize_text_key(word)
                    if not word_key:
                        continue
                    existed_file = entry_by_word.get(word_key)
                    if existed_file and existed_file != file_name:
                        ambiguous_word_keys.add(word_key)
                    else:
                        entry_by_word[word_key] = file_name

                for word_key in ambiguous_word_keys:
                    entry_by_word.pop(word_key, None)

                known_lemmas = get_lemma_words()
                merged = {}
                for item in result_data.get("suggestions", []):
                    if not isinstance(item, dict):
                        continue
                    source = item.get("source") if isinstance(item.get("source"), dict) else {}
                    target = item.get("target") if isinstance(item.get("target"), dict) else {}
                    source_file = _normalize_json_filename(source.get("file"))
                    target_file = _normalize_json_filename(target.get("file"))
                    if not source_file or not target_file:
                        continue
                    key = (source_file, target_file)
                    entry = deepcopy(item)
                    entry["source_model"] = "heuristic"
                    merged[key] = entry

                llm_suggestions = llm.get("suggestions") if isinstance(llm, dict) else []
                if isinstance(llm_suggestions, list):
                    for raw_item in llm_suggestions:
                        if not isinstance(raw_item, dict):
                            continue

                        source_file = _normalize_json_filename(raw_item.get("source_file"))
                        source_word = str(raw_item.get("source_word") or "").strip()
                        if (not source_file or source_file not in entry_by_file) and source_word:
                            source_file = entry_by_word.get(_normalize_text_key(source_word), "")
                        if not source_file or source_file not in entry_by_file:
                            continue

                        target_file = _normalize_json_filename(raw_item.get("target_file"))
                        target_word = str(raw_item.get("target_word") or "").strip()
                        if (not target_file or target_file == source_file) and target_word:
                            mapped_target = entry_by_word.get(_normalize_text_key(target_word), "")
                            if mapped_target:
                                target_file = mapped_target
                        if target_file in entry_by_file:
                            normalized_target_word = entry_by_file[target_file]["word"]
                        else:
                            normalized_target_word = target_word or os.path.splitext(target_file)[0]
                        target_word_key = _normalize_text_key(normalized_target_word)
                        if not target_word_key or target_word_key not in known_lemmas:
                            continue
                        source_word_key = _normalize_text_key(entry_by_file[source_file]["word"])
                        valid_targets = set(get_dictionary_merge_target_candidates(source_word_key))
                        if target_word_key not in valid_targets:
                            continue
                        if not target_file and target_word:
                            target_file = _normalize_json_filename(target_word)
                        if not target_file or target_file == source_file:
                            continue

                        target_exists = target_file in entry_by_file
                        if target_exists:
                            target_word = entry_by_file[target_file]["word"]
                        elif not target_word:
                            target_word = os.path.splitext(target_file)[0]

                        create_target = bool(raw_item.get("create_target_if_missing", False)) or not target_exists
                        confidence = _clamp_probability(raw_item.get("confidence"), fallback=0.7 if create_target else 0.66)
                        level = _confidence_level(confidence)
                        if level == "low" and not req.include_low_confidence:
                            continue

                        reason = str(raw_item.get("reason") or "").strip() or "LLM 建议词形归并"
                        item_type = "merge_inflection_create_target" if create_target else "merge_inflection"
                        suggested_action = (
                            "当前目录缺少原型词条；建议先新建 target，再把 source 的 definitions/examples/reviews 合并过去。"
                            if create_target
                            else "将 source 的 definitions/examples/reviews 合并到 target，保留 target 为主词条。"
                        )

                        llm_item = {
                            "type": item_type,
                            "source": {
                                "word": entry_by_file[source_file]["word"],
                                "file": source_file,
                            },
                            "target": {
                                "word": target_word,
                                "file": target_file,
                                "exists": target_exists,
                            },
                            "create_target_if_missing": create_target,
                            "confidence": round(confidence, 3),
                            "confidence_level": level,
                            "reason": reason,
                            "signals": {
                                "max_example_similarity": 0.0,
                                "target_exists": target_exists,
                                "source_definitions": 0,
                                "target_definitions": 0,
                                "source_examples": 0,
                                "target_examples": 0,
                                "source_reviews": 0,
                                "target_reviews": 0,
                            },
                            "suggested_action": suggested_action,
                            "source_model": "llm",
                        }

                        key = (source_file, target_file)
                        existed = merged.get(key)
                        if existed is None:
                            merged[key] = llm_item
                        else:
                            existed_conf = _clamp_probability(existed.get("confidence"), fallback=0.0)
                            if confidence > existed_conf:
                                llm_item["source_model"] = "hybrid"
                                merged[key] = llm_item
                            else:
                                existed["source_model"] = "hybrid"
                                merged[key] = existed

                merged_suggestions = list(merged.values())
                rank = {"high": 0, "medium": 1, "low": 2}
                merged_suggestions.sort(
                    key=lambda item: (
                        rank.get(item.get("confidence_level", "low"), 3),
                        -float(item.get("confidence", 0.0)),
                        item.get("source", {}).get("file", ""),
                    )
                )
                result_data["suggestions"] = merged_suggestions
                logger.info(
                    "[refine_folder] merge heuristic+llm done final_suggestion_count=%s",
                    len(merged_suggestions),
                )
            except Exception as exc:
                llm_error = str(exc)
                logger.exception("[refine_folder] llm analyze failed: %s", exc)

        logger.info(
            "[refine_folder] done category=%s suggestion_count=%s llm_error=%s",
            category,
            len(result_data.get("suggestions", []) if isinstance(result_data, dict) else []),
            bool(llm_error),
        )
        return {
            "status": "success",
            "category": category,
            "data": result_data,
            "skipped": skipped,
            "llm": llm,
            "llm_error": llm_error,
            "llm_enabled": bool(req.include_llm),
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/refine/merge/apply")
def apply_merge(req: MergeApplyRequest):
    try:
        category = _require_category(req.category)
        source_name = req.source_filename
        target_name = req.target_filename
        if source_name == target_name:
            raise ValueError("source_filename 和 target_filename 不能相同")

        source_path, source_payload = load_vocab_entry(category, source_name)
        target_created = False
        if req.create_target_if_missing:
            target_path = resolve_vocab_file_for_write(category, target_name)
            if os.path.exists(target_path):
                target_payload = load_vocab_file(target_path)
            else:
                target_payload = {}
                target_created = True
        else:
            target_path, target_payload = load_vocab_entry(category, target_name)

        merged_payload = _merge_vocab_payload(
            target_payload=target_payload,
            source_payload=source_payload,
            target_fallback_word=os.path.splitext(os.path.basename(target_path))[0],
        )
        save_vocab_file(target_path, merged_payload)

        if req.delete_source:
            try:
                os.remove(source_path)
            except FileNotFoundError:
                pass

        return {
            "status": "success",
            "category": category,
            "source_file": os.path.basename(source_path),
            "target_file": os.path.basename(target_path),
            "delete_source": req.delete_source,
            "create_target_if_missing": req.create_target_if_missing,
            "target_created": target_created,
            "target_data": merged_payload,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/refine/split/apply")
def apply_split(req: SplitApplyRequest):
    try:
        category = _require_category(req.category)
        source_path, existing = load_vocab_entry(category, req.source_filename)
        source_file = os.path.basename(source_path)
        source_word = str(existing.get("word") or os.path.splitext(source_file)[0]).strip() or os.path.splitext(source_file)[0]
        source_payload = _normalize_vocab_payload(
            req.data if isinstance(req.data, dict) else existing,
            fallback_word=source_word,
            fallback_created_at=str(existing.get("createdAt", "")),
        )
        split_entries = _normalize_split_apply_entries(req.suggestion)
        if not split_entries:
            raise ValueError("拆分建议为空")

        source_examples = source_payload.get("examples") if isinstance(source_payload.get("examples"), list) else []
        source_created_at = str(source_payload.get("createdAt") or existing.get("createdAt") or "")
        source_reason = str(req.suggestion.get("reason") or "").strip() if isinstance(req.suggestion, dict) else ""
        created_files = []
        updated_files = []

        for split_entry in split_entries:
            target_word = split_entry["word"]
            target_filename = _build_vocab_filename(target_word)
            target_path = resolve_vocab_file_for_write(category, target_filename)
            target_exists = os.path.exists(target_path)
            target_payload = load_vocab_file(target_path) if target_exists else {}
            addition_payload = {
                "word": target_word,
                "createdAt": source_created_at,
                "reviews": [],
                "definitions": split_entry.get("definitions") or [],
                "examples": _build_split_examples(source_examples, split_entry),
                "splitFrom": [
                    {
                        "file": source_file,
                        "word": source_word,
                        "reason": split_entry.get("reason") or source_reason,
                    }
                ],
            }
            merged_payload = _merge_split_target_payload(
                target_payload=target_payload,
                addition_payload=addition_payload,
                target_word=target_word,
                source_created_at=source_created_at,
            )
            save_vocab_file(target_path, merged_payload)

            item = {
                "file": os.path.basename(target_path),
                "word": target_word,
                "data": merged_payload,
                "created": not target_exists,
            }
            if target_exists:
                updated_files.append(item)
            else:
                created_files.append(item)

        if req.delete_source:
            try:
                os.remove(source_path)
            except FileNotFoundError:
                pass

        return {
            "status": "success",
            "category": category,
            "source_file": source_file,
            "source_deleted": bool(req.delete_source),
            "created_files": created_files,
            "updated_files": updated_files,
            "entries": created_files + updated_files,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/refine/file")
def refine_file(req: FileRefineRequest):
    try:
        category = _require_category(req.category)
        logger.info(
            "[refine_file] start category=%s filename=%s include_llm=%s has_draft=%s",
            category,
            req.filename,
            req.include_llm,
            isinstance(req.data, dict),
        )
        path, payload = load_vocab_entry(category, req.filename)
        fallback_word = os.path.splitext(os.path.basename(path))[0]

        if isinstance(req.data, dict):
            payload_for_analysis = _normalize_vocab_payload(
                req.data,
                fallback_word=fallback_word,
                fallback_created_at=str(payload.get("createdAt", "")),
            )
            analyzed_from = "draft"
        else:
            payload_for_analysis = payload
            analyzed_from = "file"

        heuristic = analyze_file_cleaning_suggestions(os.path.basename(path), payload_for_analysis)
        logger.info(
            "[refine_file] heuristic done file=%s suggestion_count=%s analyzed_from=%s",
            os.path.basename(path),
            len(heuristic.get("suggestions", []) if isinstance(heuristic, dict) else []),
            analyzed_from,
        )
        llm = None
        llm_error = None
        entry_rule_hints = suggest_entry_quality_with_rules(
            word=heuristic.get("word", ""),
            definitions=payload_for_analysis.get("definitions", []),
            examples=payload_for_analysis.get("examples", []),
        )
        rule_suggestions = list(heuristic.get("suggestions", []) if isinstance(heuristic, dict) else [])
        rule_suggestions.extend(entry_rule_hints)

        if req.include_llm:
            try:
                logger.info("[refine_file] llm analyze start file=%s", os.path.basename(path))
                llm = suggest_file_cleaning_with_llm(
                    word=heuristic.get("word", ""),
                    definitions=payload_for_analysis.get("definitions", []),
                    examples=payload_for_analysis.get("examples", []),
                    rule_suggestions=rule_suggestions,
                )
                logger.info(
                    "[refine_file] llm analyze success file=%s def_items=%s ex_items=%s",
                    os.path.basename(path),
                    len(llm.get("definitions", []) if isinstance(llm, dict) and isinstance(llm.get("definitions"), list) else []),
                    len(llm.get("examples", []) if isinstance(llm, dict) and isinstance(llm.get("examples"), list) else []),
                )
            except Exception as exc:
                llm_error = str(exc)
                logger.exception("[refine_file] llm analyze failed file=%s: %s", os.path.basename(path), exc)
        elif llm is None:
            llm = {"entry": [], "definitions": [], "examples": [], "global_notes": []}

        if isinstance(llm, dict):
            missing_definitions = any(
                isinstance(item, dict) and item.get("type") == "definition_missing"
                for item in heuristic.get("suggestions", [])
            ) if isinstance(heuristic, dict) else False
            if req.include_llm and missing_definitions:
                existing_definitions = llm.get("definitions") if isinstance(llm.get("definitions"), list) else []
                if not existing_definitions:
                    try:
                        generated_definitions = suggest_missing_definitions_with_llm(
                            word=heuristic.get("word", ""),
                            examples=payload_for_analysis.get("examples", []),
                        )
                        if generated_definitions:
                            llm["definitions"] = generated_definitions
                    except Exception as exc:
                        message = f"释义补全失败: {exc}"
                        llm_error = f"{llm_error}; {message}" if llm_error else message
                        logger.exception("[refine_file] missing definition llm failed file=%s: %s", os.path.basename(path), exc)

            missing_explanation_indices = _missing_explanation_indices(
                heuristic,
                payload_for_analysis.get("examples", []),
            )
            missing_explanation_targets = set(missing_explanation_indices)
            covered_explanation_indices = _llm_explanation_suggestion_indices(llm, missing_explanation_targets)
            missing_explanation_uncovered = [
                index
                for index in missing_explanation_indices
                if index not in covered_explanation_indices
            ]
            if (
                req.include_llm
                and missing_explanation_uncovered
            ):
                try:
                    generated_examples = suggest_missing_example_explanations_with_llm(
                        word=heuristic.get("word", ""),
                        examples=payload_for_analysis.get("examples", []),
                        missing_indices=missing_explanation_uncovered,
                    )
                    if generated_examples:
                        llm["examples"] = _merge_llm_example_suggestions(
                            llm.get("examples"),
                            generated_examples,
                        )
                except Exception as exc:
                    message = f"例句讲解补全失败: {exc}"
                    llm_error = f"{llm_error}; {message}" if llm_error else message
                    logger.exception("[refine_file] missing explanation llm failed file=%s: %s", os.path.basename(path), exc)
        logger.info(
            "[refine_file] done file=%s llm_error=%s",
            os.path.basename(path),
            bool(llm_error),
        )
        return {
            "status": "success",
            "category": category,
            "file": os.path.basename(path),
            "analyzed_from": analyzed_from,
            "heuristic": heuristic,
            "llm": llm,
            "llm_error": llm_error,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/review/suggest")
def review_suggest(req: ReviewSuggestRequest):
    try:
        category = _require_category(req.category)
        path, payload = load_vocab_entry(category, req.filename)
        reviews = payload.get("reviews") if isinstance(payload.get("reviews"), list) else []

        before = build_review_advice(reviews)
        recorded_review = None
        after = before

        if req.score is not None:
            score = clamp_score(req.score)
            review_day = date.today() if not req.review_date else parse_review_date(req.review_date)
            updated_reviews = append_or_replace_today_review(reviews, score, review_day)

            payload["reviews"] = updated_reviews
            if req.auto_save:
                save_vocab_file(path, payload)

            recorded_review = {
                "date": format_review_date(review_day),
                "score": score,
            }
            after = build_review_advice(updated_reviews)

        return {
            "status": "success",
            "category": category,
            "file": os.path.basename(path),
            "word": payload.get("word", ""),
            "before": before,
            "recorded_review": recorded_review,
            "after": after,
            "auto_saved": bool(req.score is not None and req.auto_save),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/review/recommend")
def review_recommend(req: ReviewRecommendRequest):
    try:
        limit = min(max(int(req.limit or 5), 1), 20)
        preferences = _normalize_recommendation_preferences(req)
        excluded = {str(item or "").strip() for item in (req.exclude_keys or []) if str(item or "").strip()}
        scoped_categories = [req.category] if str(req.category or "").strip() else list_categories()
        today = date.today()

        candidates = []
        scanned_files = 0
        skipped = []

        for category_name in scoped_categories:
            try:
                files = list_vocab_files(category_name)
            except Exception as exc:
                skipped.append({"category": category_name, "reason": str(exc)})
                continue

            for path in files:
                scanned_files += 1
                file_name = os.path.basename(path)
                key = f"{category_name}/{file_name}"
                if key in excluded:
                    continue

                try:
                    payload = load_vocab_file(path)
                except Exception as exc:
                    skipped.append({"category": category_name, "file": file_name, "reason": str(exc)})
                    continue

                fallback_word = os.path.splitext(file_name)[0]
                word = str(payload.get("word") or fallback_word).strip() or fallback_word
                reviews = payload.get("reviews") if isinstance(payload.get("reviews"), list) else []
                advice = build_review_advice(reviews, today=today)
                created_at = _safe_created_at(payload.get("createdAt"))
                score_result = _build_review_candidate_score(advice, created_at, today, preferences)

                candidates.append(
                    {
                        "key": key,
                        "category": category_name,
                        "file": file_name,
                        "word": word,
                        "created_at": created_at,
                        "priority_score": score_result["priority_score"],
                        "score_breakdown": score_result["score_breakdown"],
                        "reason": _build_recommendation_reason(
                            advice,
                            advice.get("last_review") if isinstance(advice.get("last_review"), dict) else None,
                        ),
                        "advice": advice,
                    }
                )

        candidates.sort(
            key=lambda item: (
                -float(item.get("priority_score", 0.0)),
                int(item.get("advice", {}).get("days_until_due", 10_000)),
                item.get("category", ""),
                item.get("file", ""),
            )
        )
        ranked = candidates[:limit]

        return {
            "status": "success",
            "scope": req.category or "all",
            "recommended": ranked[0] if ranked else None,
            "alternatives": ranked[1:],
            "meta": {
                "requested_limit": limit,
                "scanned_categories": len(scoped_categories),
                "scanned_files": scanned_files,
                "candidate_count": len(candidates),
                "excluded_count": len(excluded),
                "skipped": skipped,
                "generated_at": format_review_date(today),
                "preferences": preferences,
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
