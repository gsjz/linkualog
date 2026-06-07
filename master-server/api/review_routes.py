import logging
import os
import re
from collections import Counter, defaultdict, deque
from copy import deepcopy
from datetime import date, timedelta
from itertools import combinations
from random import Random

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.config import get_config_data
from core.refine_cache import (
    build_refine_analysis_payload,
    build_refine_cache_key,
    delete_refine_cache_for_entry,
    load_refine_cache,
    payload_fingerprint,
    save_refine_cache,
)
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
from core.vocabulary_quality import vocabulary_entry_needs_processing
from services.analysis import (
    analyze_file_cleaning_suggestions,
    analyze_folder_merge_suggestions,
)
from services.lemma_dictionary import get_lemma_words
from services.review_llm import (
    get_dictionary_merge_target_candidates,
    select_vocab_relation_candidates_with_llm,
    suggest_entry_quality_with_rules,
    suggest_file_cleaning_with_llm,
    suggest_folder_merge_with_llm,
    suggest_missing_definitions_with_llm,
    suggest_missing_example_explanations_with_llm,
    suggest_vocab_relations_with_llm,
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
_DEFAULT_RELATION_GRAPH_COMPONENT_LIMIT = 5
_RELATION_TYPE_ALIASES = {
    "": "related",
    "related": "related",
    "relation": "related",
    "same_word": "same_word",
    "sameword": "same_word",
    "phrase": "phrase",
    "fixed_phrase": "phrase",
    "idiom": "phrase",
    "variant": "variant",
    "collocation": "collocation",
    "synonym": "synonym",
    "synonyms": "synonym",
    "near_synonym": "synonym",
    "antonym": "antonym",
    "antonyms": "antonym",
    "opposite": "antonym",
    "same_category": "same_category",
    "category": "same_category",
    "same_class": "same_category",
    "same_scene": "same_scene",
    "scenario": "same_scene",
    "scene": "same_scene",
}
_RELATION_TYPE_VALUES = (
    "related",
    "same_word",
    "phrase",
    "variant",
    "collocation",
    "synonym",
    "antonym",
    "same_category",
    "same_scene",
)
_VOCAB_RELATION_KEYS = (
    "relations",
    "graphEdges",
    "graph_edges",
    "edges",
    "links",
    "related",
    "seeAlso",
    "see_also",
)


class FolderRefineRequest(BaseModel):
    category: str
    include_low_confidence: bool = False
    include_llm: bool = True


class FileRefineRequest(BaseModel):
    category: str
    filename: str
    include_llm: bool = True
    data: dict | None = None
    use_cache: bool = True
    refresh_cache: bool = False


class FileRefinePrefetchRequest(BaseModel):
    category: str
    filenames: list[str]
    limit: int = 20
    refresh_cache: bool = False


class RelationSuggestRequest(BaseModel):
    category: str
    filename: str
    data: dict | None = None
    limit: int = 12
    candidate_limit: int = 72


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
    mark_filter: str | None = None
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


class ManualVocabMergeRequest(BaseModel):
    source_category: str
    source_filename: str
    target_category: str
    target_word: str = ""
    target_filename: str = ""
    delete_source: bool = True
    create_target_if_missing: bool = True
    source_data: dict | None = None


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


def _normalize_vocab_display_word(word: str) -> str:
    return _WS_RE.sub(" ", str(word or "")).strip()


def _build_vocab_filename(word: str) -> str:
    normalized = _normalize_vocab_word(word)
    if not normalized:
        raise ValueError("word 不能为空")
    return _normalize_json_filename(normalized)


def _build_entry_ref(category: str, filename: str, word: str = "") -> dict:
    file_name = _normalize_json_filename(filename)
    display_word = _normalize_vocab_display_word(word) or os.path.splitext(file_name)[0]
    return {
        "category": _require_category(category),
        "file": file_name,
        "word": display_word,
    }


def _entry_ref_id(ref: dict) -> str:
    return f"{str(ref.get('category') or '').strip()}/{_normalize_json_filename(ref.get('file'))}"


def _normalize_relation_type(value) -> str:
    relation_type = str(value or "related").strip().lower()
    relation_type = re.sub(r"[\s\-]+", "_", relation_type)
    relation_type = re.sub(r"[^a-z0-9_]+", "", relation_type).strip("_")
    return _RELATION_TYPE_ALIASES.get(relation_type, "related")


def _relation_ref_from_item(item, default_category: str = "") -> dict | None:
    if isinstance(item, str):
        raw = item.strip()
        if not raw:
            return None
        if "/" in raw:
            category_part, file_part = raw.rsplit("/", 1)
            category = str(category_part or default_category).strip()
            if file_part.lower().endswith(".json"):
                word = os.path.splitext(_normalize_json_filename(file_part))[0]
                return _build_entry_ref(category, file_part, word)
            return _build_entry_ref(category, _build_vocab_filename(file_part), file_part)
        return _build_entry_ref(default_category, _build_vocab_filename(raw), raw)

    if not isinstance(item, dict):
        return None

    nested_target = (
        item.get("target")
        or item.get("to")
        or item.get("entry")
        or item.get("node")
    )
    if isinstance(nested_target, (dict, str)):
        nested = _relation_ref_from_item(nested_target, default_category)
        if nested:
            return nested

    category = str(
        item.get("category")
        or item.get("target_category")
        or item.get("targetCategory")
        or item.get("dir")
        or item.get("folder")
        or default_category
    ).strip()
    raw_file = str(
        item.get("file")
        or item.get("filename")
        or item.get("target_file")
        or item.get("targetFile")
        or ""
    ).strip()
    word = _normalize_vocab_display_word(
        item.get("word")
        or item.get("target_word")
        or item.get("targetWord")
        or item.get("label")
        or ""
    )

    if not raw_file and word:
        raw_file = _build_vocab_filename(word)
    if not raw_file:
        return None
    return _build_entry_ref(category, raw_file, word)


def _normalize_relation_item(item, default_category: str, source_ref: dict | None = None) -> dict | None:
    target_ref = _relation_ref_from_item(item, default_category)
    if not target_ref:
        return None
    if source_ref and _entry_ref_id(target_ref) == _entry_ref_id(source_ref):
        return None

    relation_type = "related"
    reason = ""
    source = ""
    if isinstance(item, dict):
        relation_type = _normalize_relation_type(item.get("type") or item.get("relation") or "related")
        reason = str(item.get("reason") or item.get("note") or "").strip()
        source = str(item.get("source") or item.get("origin") or "").strip()

    relation = {
        "type": _normalize_relation_type(relation_type),
        "target": target_ref,
    }
    if reason:
        relation["reason"] = reason
    if source:
        relation["source"] = source
    return relation


def _normalize_relations(raw_payload: dict, default_category: str, source_ref: dict | None = None) -> list[dict]:
    if not isinstance(raw_payload, dict):
        return []

    relations = []
    for key in _VOCAB_RELATION_KEYS:
        raw_value = raw_payload.get(key)
        if not isinstance(raw_value, list):
            continue
        for item in raw_value:
            relation = _normalize_relation_item(item, default_category, source_ref)
            if relation:
                relations.append(relation)

    deduped = []
    seen = set()
    for relation in relations:
        target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
        key = (
            _entry_ref_id(target_ref),
            _normalize_relation_type(relation.get("type") or "related"),
        )
        if not key[0] or key in seen:
            continue
        seen.add(key)
        deduped.append(relation)
    return deduped


def _replace_payload_relation_targets(payload: dict, old_ref: dict, new_ref: dict) -> dict:
    if not isinstance(payload, dict):
        return payload
    source_ref = _build_entry_ref(
        str(new_ref.get("category") or old_ref.get("category") or ""),
        str(new_ref.get("file") or old_ref.get("file") or ""),
        str(new_ref.get("word") or old_ref.get("word") or ""),
    )
    normalized = _normalize_relations(payload, str(source_ref.get("category") or ""), source_ref=source_ref)
    old_id = _entry_ref_id(old_ref)
    new_id = _entry_ref_id(new_ref)
    for relation in normalized:
        target = relation.get("target") if isinstance(relation.get("target"), dict) else {}
        if _entry_ref_id(target) == old_id:
            relation["target"] = {
                "category": new_ref["category"],
                "file": new_ref["file"],
                "word": new_ref["word"],
            }
    payload.pop("graphEdges", None)
    payload.pop("graph_edges", None)
    payload.pop("edges", None)
    payload.pop("links", None)
    payload.pop("related", None)
    payload.pop("seeAlso", None)
    payload.pop("see_also", None)
    if normalized:
        payload["relations"] = _normalize_relations({"relations": normalized}, str(source_ref.get("category") or ""), source_ref=source_ref)
    else:
        payload.pop("relations", None)
    if old_id != new_id:
        payload = _remove_relation_to_ref(payload, source_ref)
    return payload


def _remove_relation_to_ref(payload: dict, target_ref: dict) -> dict:
    if not isinstance(payload, dict):
        return payload
    target_id = _entry_ref_id(target_ref)
    relations = [
        relation
        for relation in _normalize_relations(payload, str(target_ref.get("category") or ""))
        if _entry_ref_id(relation.get("target", {})) != target_id
    ]
    if relations:
        payload["relations"] = relations
    else:
        payload.pop("relations", None)
    return payload


def _rewrite_relation_target_in_payload(payload: dict, source_ref: dict, old_ref: dict, new_ref: dict) -> tuple[dict, bool]:
    if not isinstance(payload, dict):
        return payload, False
    source_id = _entry_ref_id(source_ref)
    old_id = _entry_ref_id(old_ref)
    new_id = _entry_ref_id(new_ref)
    relations = _normalize_relations(payload, str(source_ref.get("category") or ""), source_ref=source_ref)
    changed = False
    next_relations = []
    seen = set()
    for relation in relations:
        target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
        target_id = _entry_ref_id(target_ref)
        if target_id == old_id:
            if new_id == source_id:
                changed = True
                continue
            relation = {
                **relation,
                "target": {
                    "category": new_ref["category"],
                    "file": new_ref["file"],
                    "word": new_ref["word"],
                },
            }
            changed = True
            target_id = new_id
        key = (target_id, _normalize_relation_type(relation.get("type") or "related"))
        if not key[0] or key in seen:
            changed = True
            continue
        seen.add(key)
        next_relations.append(relation)

    for key in _VOCAB_RELATION_KEYS:
        if key != "relations":
            payload.pop(key, None)
    if next_relations:
        payload["relations"] = next_relations
    else:
        changed = changed or bool(payload.get("relations"))
        payload.pop("relations", None)
    return payload, changed


def _rewrite_all_relation_targets(old_ref: dict, new_ref: dict) -> int:
    old_id = _entry_ref_id(old_ref)
    new_id = _entry_ref_id(new_ref)
    if not old_id or not new_id or old_id == new_id:
        return 0

    updated = 0
    for category_name in list_categories():
        try:
            files = list_vocab_files(category_name)
        except Exception:
            continue
        for path in files:
            file_name = os.path.basename(path)
            source_ref = _build_entry_ref(category_name, file_name, "")
            if _entry_ref_id(source_ref) == old_id:
                continue
            try:
                payload = load_vocab_file(path)
            except Exception:
                continue
            source_ref = _build_entry_ref(category_name, file_name, payload.get("word") or os.path.splitext(file_name)[0])
            next_payload, changed = _rewrite_relation_target_in_payload(payload, source_ref, old_ref, new_ref)
            if not changed:
                continue
            save_vocab_file(path, next_payload)
            updated += 1
    return updated


def _find_incoming_relations(target_ref: dict) -> list[dict]:
    target_id = _entry_ref_id(target_ref)
    if not target_id:
        return []
    incoming = []
    for category_name in list_categories():
        try:
            files = list_vocab_files(category_name)
        except Exception:
            continue
        for path in files:
            file_name = os.path.basename(path)
            source_id = _entry_ref_id(_build_entry_ref(category_name, file_name, ""))
            if source_id == target_id:
                continue
            try:
                payload = load_vocab_file(path)
            except Exception:
                continue
            source_ref = _build_entry_ref(category_name, file_name, payload.get("word") or os.path.splitext(file_name)[0])
            for relation in _normalize_relations(payload, category_name, source_ref=source_ref):
                relation_target = relation.get("target") if isinstance(relation.get("target"), dict) else {}
                if _entry_ref_id(relation_target) != target_id:
                    continue
                incoming.append(
                    {
                        "type": _normalize_relation_type(relation.get("type") or "related"),
                        "target": source_ref,
                        "reason": str(relation.get("reason") or ""),
                        "source": str(relation.get("source") or "incoming"),
                    }
                )
    return incoming


def _upsert_relation(payload: dict, source_ref: dict, target_ref: dict, relation_type: str = "related", reason: str = "", origin: str = "") -> dict:
    if not isinstance(payload, dict):
        payload = {}
    if _entry_ref_id(source_ref) == _entry_ref_id(target_ref):
        return payload

    relations = _normalize_relations(payload, str(source_ref.get("category") or ""), source_ref=source_ref)
    target_id = _entry_ref_id(target_ref)
    normalized_type = _normalize_relation_type(relation_type)
    for relation in relations:
        target = relation.get("target") if isinstance(relation.get("target"), dict) else {}
        if _entry_ref_id(target) == target_id and _normalize_relation_type(relation.get("type") or "related") == normalized_type:
            relation["target"] = {
                "category": target_ref["category"],
                "file": target_ref["file"],
                "word": target_ref["word"],
            }
            if reason and not str(relation.get("reason") or "").strip():
                relation["reason"] = reason
            if origin and not str(relation.get("source") or "").strip():
                relation["source"] = origin
            payload["relations"] = relations
            return payload

    relation = {
        "type": normalized_type,
        "target": {
            "category": target_ref["category"],
            "file": target_ref["file"],
            "word": target_ref["word"],
        },
    }
    if reason:
        relation["reason"] = reason
    if origin:
        relation["source"] = origin
    relations.append(relation)
    payload["relations"] = relations
    return payload


def _load_entry_by_ref(ref: dict) -> tuple[str, dict] | None:
    try:
        return load_vocab_entry(str(ref.get("category") or ""), str(ref.get("file") or ""))
    except FileNotFoundError:
        return None


def _ensure_bidirectional_relation(
    source_ref: dict,
    target_ref: dict,
    *,
    relation_type: str = "related",
    reason: str = "",
    origin: str = "",
) -> None:
    if _entry_ref_id(source_ref) == _entry_ref_id(target_ref):
        return

    for current_ref, other_ref in ((source_ref, target_ref), (target_ref, source_ref)):
        loaded = _load_entry_by_ref(current_ref)
        if not loaded:
            continue
        path, payload = loaded
        normalized = _normalize_vocab_payload(
            payload,
            fallback_word=str(current_ref.get("word") or os.path.splitext(str(current_ref.get("file") or ""))[0]),
            fallback_created_at=str(payload.get("createdAt", "")),
            category=str(current_ref.get("category") or ""),
            filename=str(current_ref.get("file") or ""),
        )
        next_payload = _upsert_relation(
            normalized,
            current_ref,
            other_ref,
            relation_type=relation_type,
            reason=reason,
            origin=origin,
        )
        save_vocab_file(path, next_payload)


def _relation_key(relation: dict) -> tuple[str, str]:
    if not isinstance(relation, dict):
        return ("", "")
    target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
    relation_type = _normalize_relation_type(relation.get("type") or "related")
    return (_entry_ref_id(target_ref), relation_type)


def _remove_reverse_relation(target_ref: dict, source_ref: dict, relation_type: str) -> None:
    loaded = _load_entry_by_ref(target_ref)
    if not loaded:
        return

    path, payload = loaded
    normalized = _normalize_vocab_payload(
        payload,
        fallback_word=str(target_ref.get("word") or os.path.splitext(str(target_ref.get("file") or ""))[0]),
        fallback_created_at=str(payload.get("createdAt", "")),
        category=str(target_ref.get("category") or ""),
        filename=str(target_ref.get("file") or ""),
    )
    source_id = _entry_ref_id(source_ref)
    normalized_type = _normalize_relation_type(relation_type)
    relations = _normalize_relations(normalized, str(target_ref.get("category") or ""), source_ref=target_ref)
    filtered = [
        relation
        for relation in relations
        if not (
            _entry_ref_id(relation.get("target", {})) == source_id
            and _normalize_relation_type(relation.get("type") or "related") == normalized_type
        )
    ]
    if len(filtered) == len(relations):
        return
    if filtered:
        normalized["relations"] = filtered
    else:
        normalized.pop("relations", None)
    save_vocab_file(path, normalized)


def _sync_bidirectional_relations_for_entry(
    category: str,
    filename: str,
    before_payload: dict,
    after_payload: dict,
    before_filename: str | None = None,
) -> None:
    if not isinstance(after_payload, dict):
        return
    old_filename = before_filename or filename
    before_source_ref = _build_entry_ref(
        category,
        old_filename,
        before_payload.get("word") or os.path.splitext(old_filename)[0] if isinstance(before_payload, dict) else os.path.splitext(old_filename)[0],
    )
    source_ref = _build_entry_ref(
        category,
        filename,
        after_payload.get("word") or os.path.splitext(filename)[0],
    )
    before_relations = _normalize_relations(before_payload, category, source_ref=before_source_ref)
    after_relations = _normalize_relations(after_payload, category, source_ref=source_ref)
    source_changed = _entry_ref_id(before_source_ref) != _entry_ref_id(source_ref)

    before_by_key = {_relation_key(relation): relation for relation in before_relations}
    after_by_key = {_relation_key(relation): relation for relation in after_relations}

    for key, relation in before_by_key.items():
        if key in after_by_key and not source_changed:
            continue
        target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
        if _entry_ref_id(target_ref):
            _remove_reverse_relation(target_ref, before_source_ref, key[1])

    for relation in after_relations:
        target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
        if not _entry_ref_id(target_ref):
            continue
        _ensure_bidirectional_relation(
            source_ref,
            target_ref,
            relation_type=str(relation.get("type") or "related"),
            reason=str(relation.get("reason") or ""),
            origin=str(relation.get("source") or "manual"),
        )


def _normalize_payload_relations_for_entry(payload: dict, category: str, filename: str) -> dict:
    if not isinstance(payload, dict):
        return payload
    source_ref = _build_entry_ref(category, filename, payload.get("word") or os.path.splitext(filename)[0])
    relations = _normalize_relations(payload, category, source_ref=source_ref)
    for key in _VOCAB_RELATION_KEYS:
        if key != "relations":
            payload.pop(key, None)
    if relations:
        payload["relations"] = relations
    else:
        payload.pop("relations", None)
    return payload


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
    return _build_recommendation_preferences_from_values(
        due_weight=req.due_weight,
        created_weight=req.created_weight,
        score_weight=req.score_weight,
        created_order=req.created_order,
        score_order=req.score_order,
    )


def _normalize_recommendation_mark_filter(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"marked", "unmarked", "needs_processing"}:
        return normalized
    return "all"


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


def _build_recommendation_preferences_from_values(
    *,
    due_weight=None,
    created_weight=None,
    score_weight=None,
    created_order=None,
    score_order=None,
) -> dict:
    server_config = get_config_data()
    defaults = {
        key: server_config.get(config_key, fallback)
        for key, config_key in _RECOMMENDATION_CONFIG_KEYS.items()
        for fallback in [_DEFAULT_RECOMMENDATION_PREFERENCES[key]]
    }
    return {
        "due_weight": _clamp_recommendation_weight(
            due_weight,
            defaults["due_weight"],
        ),
        "created_weight": _clamp_recommendation_weight(
            created_weight,
            defaults["created_weight"],
        ),
        "score_weight": _clamp_recommendation_weight(
            score_weight,
            defaults["score_weight"],
        ),
        "created_order": _normalize_recommendation_choice(
            created_order,
            _RECOMMENDATION_CREATED_ORDERS,
            defaults["created_order"],
            "created_order",
        ),
        "score_order": _normalize_recommendation_choice(
            score_order,
            _RECOMMENDATION_SCORE_ORDERS,
            defaults["score_order"],
            "score_order",
        ),
    }


def _safe_int_range(value, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = fallback
    return min(max(number, minimum), maximum)


def _score_review_candidate(advice: dict, created_at: str, today: date) -> float:
    return _build_review_candidate_score(
        advice,
        created_at,
        today,
        _DEFAULT_RECOMMENDATION_PREFERENCES,
    )["priority_score"]


def _format_month_key(value: date) -> str:
    return value.strftime("%Y-%m")


def _default_daily_review_counts(today: date, days: int = 14) -> list[dict]:
    start = today - timedelta(days=max(days - 1, 0))
    return [
        {
            "date": format_review_date(start + timedelta(days=offset)),
            "count": 0,
        }
        for offset in range(days)
    ]


def _score_bucket(score: int | None) -> str:
    if score is None:
        return "unreviewed"
    if score >= 4:
        return "mastered"
    if score >= 2:
        return "familiar"
    return "unfamiliar"


def _entry_example_feature_flags(payload: dict) -> dict:
    examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []
    has_examples = bool(examples)
    has_focus = False
    has_explanation = False
    has_source = False
    has_youtube = False

    for example in examples:
        if not isinstance(example, dict):
            continue
        raw_focus_positions = example.get("focusPositions", example.get("focusPosition", example.get("fp", example.get("fps"))))
        raw_focus_words = example.get("focusWords")
        if isinstance(raw_focus_positions, list) and raw_focus_positions:
            has_focus = True
        if isinstance(raw_focus_words, list) and any(str(item or "").strip() for item in raw_focus_words):
            has_focus = True
        if str(example.get("explanation") or "").strip():
            has_explanation = True
        source = example.get("source")
        if isinstance(source, dict) and (str(source.get("text") or "").strip() or str(source.get("url") or "").strip()):
            has_source = True
        if isinstance(example.get("youtube"), dict) and str(example["youtube"].get("url") or "").strip():
            has_youtube = True

    return {
        "has_examples": has_examples,
        "has_focus": has_focus,
        "has_explanation": has_explanation,
        "has_source": has_source,
        "has_youtube": has_youtube,
    }


def _build_feature_share_items(counts: dict[str, int], total: int) -> list[dict]:
    labels = {
        "has_examples": "带例句",
        "has_focus": "有重点词",
        "has_explanation": "有解析",
        "has_source": "有来源",
        "has_youtube": "YouTube 来源",
        "marked": "已标记",
    }
    return [
        {
            "key": key,
            "label": label,
            "count": int(counts.get(key, 0)),
            "ratio": round((int(counts.get(key, 0)) / total), 4) if total > 0 else 0.0,
        }
        for key, label in labels.items()
    ]


def _review_status_label(status: str) -> str:
    labels = {
        "overdue": "已逾期",
        "due_today": "今日到期",
        "due_soon": "即将到期",
        "scheduled": "已安排",
        "new": "新词",
    }
    return labels.get(status, status or "未知")


def _score_bucket_label(bucket: str) -> str:
    labels = {
        "mastered": "熟练",
        "familiar": "熟悉",
        "unfamiliar": "陌生",
        "unreviewed": "未复习",
    }
    return labels.get(bucket, bucket or "未知")


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


def _normalize_vocab_payload(
    raw_payload: dict,
    fallback_word: str,
    fallback_created_at: str = "",
    *,
    category: str = "",
    filename: str = "",
) -> dict:
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
    if category and filename:
        payload = _normalize_payload_relations_for_entry(payload, category, filename)
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


def _merge_vocab_payload(
    target_payload: dict,
    source_payload: dict,
    target_fallback_word: str,
    *,
    target_category: str = "",
    target_filename: str = "",
    source_category: str = "",
    source_filename: str = "",
) -> dict:
    target = _normalize_vocab_payload(
        target_payload,
        target_fallback_word,
        category=target_category,
        filename=target_filename,
    )
    source = _normalize_vocab_payload(
        source_payload,
        str(source_payload.get("word") or ""),
        category=source_category,
        filename=source_filename,
    )

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

    source_relations = _normalize_relations(source, source_category or target_category)
    if source_relations:
        target_ref = _build_entry_ref(target_category or source_category, target_filename or _build_vocab_filename(target.get("word", target_fallback_word)), target.get("word") or target_fallback_word)
        for relation in source_relations:
            target_relation_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
            target = _upsert_relation(
                target,
                target_ref,
                target_relation_ref,
                relation_type=str(relation.get("type") or "related"),
                reason=str(relation.get("reason") or ""),
                origin=str(relation.get("source") or ""),
            )

    return target


def _finalize_vocab_merge_relations(
    *,
    source_ref: dict,
    target_ref: dict,
    merged_payload: dict,
) -> tuple[dict, int]:
    merged_payload = _remove_relation_to_ref(merged_payload, source_ref)
    merged_payload = _remove_relation_to_ref(merged_payload, target_ref)
    rewritten_count = _rewrite_all_relation_targets(source_ref, target_ref)
    return merged_payload, rewritten_count


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
    *,
    target_category: str = "",
    target_filename: str = "",
) -> dict:
    target = _normalize_vocab_payload(
        target_payload,
        fallback_word=target_word,
        fallback_created_at=source_created_at,
        category=target_category,
        filename=target_filename,
    )
    addition = _normalize_vocab_payload(
        addition_payload,
        fallback_word=target_word,
        fallback_created_at=source_created_at,
        category=target_category,
        filename=target_filename,
    )

    target["reviews"] = _safe_reviews(
        (target.get("reviews") or []) + (addition.get("reviews") or [])
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

    addition_relations = _normalize_relations(addition, target_category)
    if addition_relations:
        target_ref = _build_entry_ref(target_category, target_filename or _build_vocab_filename(target_word), target_word)
        for relation in addition_relations:
            target = _upsert_relation(
                target,
                target_ref,
                relation.get("target", {}),
                relation_type=str(relation.get("type") or "related"),
                reason=str(relation.get("reason") or ""),
                origin=str(relation.get("source") or ""),
            )

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


def _delete_refine_cache_if_analysis_changed(
    category: str,
    file_name: str,
    before_payload: dict,
    after_payload: dict,
) -> int:
    before_hash = payload_fingerprint(build_refine_analysis_payload(file_name, before_payload))
    after_hash = payload_fingerprint(build_refine_analysis_payload(file_name, after_payload))
    if before_hash == after_hash:
        return 0
    return delete_refine_cache_for_entry(category, file_name)


def _build_relation_graph(nodes_by_id: dict[str, dict], raw_edges: list[dict]) -> dict:
    dedup_edges = []
    seen_edges = set()
    adjacency: dict[str, set[str]] = defaultdict(set)

    for edge in raw_edges:
        source_id = str(edge.get("source") or "").strip()
        target_id = str(edge.get("target") or "").strip()
        if not source_id or not target_id or source_id == target_id:
            continue
        if source_id not in nodes_by_id or target_id not in nodes_by_id:
            continue
        pair = tuple(sorted((source_id, target_id)))
        edge_type = str(edge.get("type") or "related").strip() or "related"
        key = (pair[0], pair[1], edge_type)
        if key in seen_edges:
            continue
        seen_edges.add(key)
        same_category = nodes_by_id[source_id].get("category") == nodes_by_id[target_id].get("category")
        edge_item = {
            "source": source_id,
            "target": target_id,
            "type": edge_type,
            "scope": "same_category" if same_category else "cross_category",
            "same_category": same_category,
        }
        if edge.get("reason"):
            edge_item["reason"] = str(edge.get("reason") or "")
        if edge.get("source_kind"):
            edge_item["source_kind"] = str(edge.get("source_kind") or "")
        dedup_edges.append(edge_item)
        adjacency[source_id].add(target_id)
        adjacency[target_id].add(source_id)

    components = []
    visited = set()
    for node_id in sorted(nodes_by_id):
        if node_id in visited or not adjacency.get(node_id):
            continue
        queue = deque([node_id])
        visited.add(node_id)
        component_ids = []
        while queue:
            current = queue.popleft()
            component_ids.append(current)
            for neighbor in sorted(adjacency.get(current, [])):
                if neighbor in visited:
                    continue
                visited.add(neighbor)
                queue.append(neighbor)

        if len(component_ids) < 2:
            continue
        component_id_set = set(component_ids)
        component_edges = [
            edge
            for edge in dedup_edges
            if edge["source"] in component_id_set and edge["target"] in component_id_set
        ]
        if not component_edges:
            continue
        component_nodes = [nodes_by_id[item] for item in sorted(component_ids)]
        components.append(
            {
                "id": f"component-{len(components) + 1}",
                "nodes": component_nodes,
                "edges": component_edges,
                "node_count": len(component_nodes),
                "edge_count": len(component_edges),
                "categories": sorted({str(node.get("category") or "") for node in component_nodes}),
            }
        )

    components.sort(
        key=lambda item: (
            -int(item.get("node_count") or 0),
            -int(item.get("edge_count") or 0),
            ",".join(item.get("categories") or []),
        )
    )
    for index, component in enumerate(components, start=1):
        component["id"] = f"component-{index}"

    return {
        "nodes": list(nodes_by_id.values()),
        "edges": dedup_edges,
        "components": components,
        "component_count": len(components),
        "connected_node_count": len({node_id for edge in dedup_edges for node_id in (edge["source"], edge["target"])}),
    }


def _component_review_priority(component: dict) -> dict:
    nodes = component.get("nodes") if isinstance(component.get("nodes"), list) else []
    node_scores = []
    due_node_count = 0
    for node in nodes:
        if not isinstance(node, dict):
            continue
        try:
            score = float(node.get("review_priority_score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        node_scores.append((score, node))
        if str(node.get("review_status") or "") in {"overdue", "due_today", "due_soon", "new"}:
            due_node_count += 1

    score_values = [item[0] for item in node_scores]
    total_score = round(sum(score_values), 3)
    max_score = round(max(score_values) if score_values else 0.0, 3)
    average_score = round(total_score / len(score_values), 3) if score_values else 0.0
    top_nodes = []
    for score, node in sorted(
        node_scores,
        key=lambda item: (
            -item[0],
            str(item[1].get("category") or ""),
            str(item[1].get("file") or ""),
        ),
    )[:3]:
        top_nodes.append(
            {
                "id": node.get("id"),
                "category": node.get("category"),
                "file": node.get("file"),
                "word": node.get("word"),
                "priority_score": round(score, 3),
                "review_status": node.get("review_status"),
                "review_status_label": node.get("review_status_label"),
            }
        )

    return {
        "max_score": max_score,
        "total_score": total_score,
        "average_score": average_score,
        "due_node_count": due_node_count,
        "top_nodes": top_nodes,
    }


def _rank_relation_graph_components_by_review_value(relation_graph: dict) -> None:
    components = relation_graph.get("components") if isinstance(relation_graph.get("components"), list) else []
    for component in components:
        if not isinstance(component, dict):
            continue
        component["review_priority"] = _component_review_priority(component)

    components.sort(
        key=lambda item: (
            -float(item.get("review_priority", {}).get("max_score") or 0.0),
            -float(item.get("review_priority", {}).get("total_score") or 0.0),
            -int(item.get("review_priority", {}).get("due_node_count") or 0),
            -int(item.get("node_count") or 0),
            -int(item.get("edge_count") or 0),
            ",".join(item.get("categories") or []),
        )
    )
    for index, component in enumerate(components, start=1):
        component["id"] = f"component-{index}"
        component["review_priority"]["rank"] = index


def _select_relation_graph_components(
    relation_graph: dict,
    *,
    limit: int = _DEFAULT_RELATION_GRAPH_COMPONENT_LIMIT,
    randomize: bool = False,
    seed: str | None = None,
) -> dict:
    components = relation_graph.get("components") if isinstance(relation_graph.get("components"), list) else []
    limit = _safe_int_range(limit, _DEFAULT_RELATION_GRAPH_COMPONENT_LIMIT, 1, 20)
    default_components = components[:limit]
    selection_mode = "recommended"

    if randomize and len(components) > limit:
        selection_mode = "random"
        rng = Random(str(seed or os.urandom(8).hex()))
        default_ids = {str(component.get("id") or "") for component in default_components}
        alternative_pool = [
            component
            for component in components
            if str(component.get("id") or "") not in default_ids
        ]
        if len(alternative_pool) >= limit:
            selected_components = rng.sample(alternative_pool, limit)
        else:
            selected_components = list(alternative_pool)
            fallback_pool = [
                component
                for component in default_components
                if str(component.get("id") or "") not in {
                    str(item.get("id") or "") for item in selected_components
                }
            ]
            rng.shuffle(fallback_pool)
            selected_components.extend(fallback_pool[: max(0, limit - len(selected_components))])
        rng.shuffle(selected_components)
    else:
        selected_components = default_components

    selected_ids = {str(component.get("id") or "") for component in selected_components}
    selected_node_ids = {
        str(node.get("id") or "")
        for component in selected_components
        for node in component.get("nodes", [])
        if isinstance(node, dict) and str(node.get("id") or "")
    }
    selected_edge_ids = {
        (
            str(edge.get("source") or ""),
            str(edge.get("target") or ""),
            str(edge.get("type") or "related"),
        )
        for component in selected_components
        for edge in component.get("edges", [])
        if isinstance(edge, dict)
    }

    return {
        **relation_graph,
        "components": selected_components,
        "component_count": len(selected_components),
        "recommended_component_count": len(default_components),
        "available_component_count": len(components),
        "selected_connected_node_count": len(selected_node_ids),
        "selected_edge_count": len(selected_edge_ids),
        "selection": {
            "mode": selection_mode,
            "limit": limit,
            "seed": str(seed or "") if randomize else "",
            "selected_component_ids": [str(component.get("id") or "") for component in selected_components],
            "default_component_ids": [str(component.get("id") or "") for component in default_components],
            "has_more": len(components) > limit,
            "available_component_count": len(components),
            "selected_component_count": len(selected_components),
        },
        "all_component_count": len(components),
        "all_component_ids": [str(component.get("id") or "") for component in components],
        "hidden_component_ids": [
            str(component.get("id") or "")
            for component in components
            if str(component.get("id") or "") not in selected_ids
        ],
    }


def _relation_prompt_examples(payload: dict, limit: int = 2) -> list[dict]:
    examples = []
    for example in payload.get("examples") if isinstance(payload.get("examples"), list) else []:
        if not isinstance(example, dict):
            continue
        text = str(example.get("text") or "").strip()
        explanation = str(example.get("explanation") or "").strip()
        focus_words = example.get("focusWords") if isinstance(example.get("focusWords"), list) else []
        if not text and not explanation:
            continue
        examples.append(
            {
                "text": text[:320],
                "explanation": explanation[:220],
                "focusWords": [str(item).strip() for item in focus_words if str(item).strip()][:4],
            }
        )
        if len(examples) >= limit:
            break
    return examples


def _relation_entry_summary(category: str, file_name: str, payload: dict, signals: list[str] | None = None) -> dict:
    fallback_word = os.path.splitext(file_name)[0]
    word = _normalize_vocab_display_word(payload.get("word") or fallback_word) or fallback_word
    return {
        "category": category,
        "file": file_name,
        "word": word,
        "definitions": _safe_definitions(payload.get("definitions"))[:3],
        "examples": _relation_prompt_examples(payload, limit=2),
        "signals": signals or [],
    }


def _build_compact_vocabulary_index(source_ref: dict) -> tuple[dict, dict[str, dict], list[dict]]:
    source_id = _entry_ref_id(source_ref)
    word_index = {}
    candidate_by_id = {}
    skipped = []

    for category_name in list_categories():
        try:
            files = list_vocab_files(category_name)
        except Exception as exc:
            skipped.append({"category": category_name, "reason": str(exc)})
            continue

        words = []
        for path in files:
            file_name = os.path.basename(path)
            ref_id = _entry_ref_id(_build_entry_ref(category_name, file_name, ""))
            if ref_id == source_id:
                continue
            try:
                payload = load_vocab_file(path)
            except Exception as exc:
                skipped.append({"category": category_name, "file": file_name, "reason": str(exc)})
                continue
            word = _normalize_vocab_display_word(payload.get("word") or os.path.splitext(file_name)[0]) or os.path.splitext(file_name)[0]
            words.append(word)
            candidate_by_id[ref_id] = {
                "category": category_name,
                "file": file_name,
                "word": word,
                "definitions": _safe_definitions(payload.get("definitions"))[:2],
            }
        if words:
            word_index[category_name] = sorted(set(words), key=lambda item: item.lower())

    return word_index, candidate_by_id, skipped


def _candidate_refs_from_words(
    words_by_category: dict,
    candidate_by_id: dict[str, dict],
    *,
    fallback_category: str,
    limit: int,
) -> list[dict]:
    if not isinstance(words_by_category, dict):
        return []
    by_category_word: dict[tuple[str, str], list[dict]] = defaultdict(list)
    by_word: dict[str, list[dict]] = defaultdict(list)
    for candidate in candidate_by_id.values():
        category = str(candidate.get("category") or "")
        word_key = _normalize_text_key(candidate.get("word"))
        if not category or not word_key:
            continue
        by_category_word[(category, word_key)].append(candidate)
        by_word[word_key].append(candidate)

    selected = []
    seen = set()
    for raw_category, raw_words in words_by_category.items():
        category = str(raw_category or fallback_category).strip() or fallback_category
        values = raw_words
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list):
            continue
        for raw_word in values:
            word_key = _normalize_text_key(raw_word)
            if not word_key:
                continue
            matches = by_category_word.get((category, word_key)) or by_word.get(word_key) or []
            for match in matches:
                ref_id = _entry_ref_id(match)
                if not ref_id or ref_id in seen:
                    continue
                seen.add(ref_id)
                selected.append(match)
                if len(selected) >= max(1, int(limit or 5)):
                    return selected
    return selected


def _load_relation_candidate_summaries(candidate_refs: list[dict], source_ref: dict, source_payload: dict) -> tuple[list[dict], list[dict]]:
    candidates = []
    skipped = []
    for ref in candidate_refs:
        try:
            path, payload = load_vocab_entry(str(ref.get("category") or ""), str(ref.get("file") or ""))
        except Exception as exc:
            skipped.append({"category": ref.get("category"), "file": ref.get("file"), "reason": str(exc)})
            continue
        file_name = os.path.basename(path)
        summary = _relation_entry_summary(str(ref.get("category") or ""), file_name, payload)
        summary["data"] = payload if isinstance(payload, dict) else {}
        score, signals = _relation_candidate_score(source_ref, source_payload, summary)
        summary["signals"] = signals
        summary["_score"] = score
        candidates.append(summary)

    candidates.sort(
        key=lambda item: (
            -int(item.get("_score") or 0),
            str(item.get("category") or ""),
            str(item.get("word") or ""),
            str(item.get("file") or ""),
        )
    )
    for item in candidates:
        item.pop("_score", None)
    return candidates, skipped


def _relation_word_tokens(value: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", _normalize_text_key(value))


def _is_contiguous_subsequence(short_tokens: list[str], long_tokens: list[str]) -> bool:
    if not short_tokens or len(short_tokens) >= len(long_tokens):
        return False
    max_start = len(long_tokens) - len(short_tokens)
    for start in range(max_start + 1):
        if long_tokens[start : start + len(short_tokens)] == short_tokens:
            return True
    return False


def _relation_candidate_score(source_ref: dict, source_payload: dict, candidate: dict) -> tuple[int, list[str]]:
    source_word = str(source_ref.get("word") or "")
    target_word = str(candidate.get("word") or "")
    source_key = _normalize_text_key(source_word)
    target_key = _normalize_text_key(target_word)
    source_tokens = _relation_word_tokens(source_word)
    target_tokens = _relation_word_tokens(target_word)
    score = 0
    signals = []

    if source_key and source_key == target_key:
        score += 140
        signals.append("same_word")
    if _is_contiguous_subsequence(source_tokens, target_tokens) or _is_contiguous_subsequence(target_tokens, source_tokens):
        score += 115
        signals.append("phrase_contains")
    shared_tokens = sorted(set(source_tokens).intersection(target_tokens))
    if shared_tokens:
        score += min(80, len(shared_tokens) * 22)
        signals.append(f"shared_tokens:{','.join(shared_tokens[:4])}")
    if str(source_ref.get("category") or "") == str(candidate.get("category") or ""):
        score += 8
        signals.append("same_category")

    definitions_blob = _normalize_text_key(" ".join(_safe_definitions(source_payload.get("definitions"))))
    target_definitions_blob = _normalize_text_key(" ".join(candidate.get("definitions") or []))
    if source_key and source_key in target_definitions_blob:
        score += 28
        signals.append("source_word_in_target_definition")
    if target_key and target_key in definitions_blob:
        score += 28
        signals.append("target_word_in_source_definition")

    return score, signals


def _build_relation_candidates(
    source_ref: dict,
    source_payload: dict,
    candidate_limit: int,
) -> tuple[list[dict], list[dict]]:
    normalized_limit = max(12, min(int(candidate_limit or 72), 180))
    candidates = []
    skipped = []
    source_id = _entry_ref_id(source_ref)

    for category_name in list_categories():
        try:
            files = list_vocab_files(category_name)
        except Exception as exc:
            skipped.append({"category": category_name, "reason": str(exc)})
            continue

        for path in files:
            file_name = os.path.basename(path)
            if _entry_ref_id(_build_entry_ref(category_name, file_name, "")) == source_id:
                continue
            try:
                payload = load_vocab_file(path)
            except Exception as exc:
                skipped.append({"category": category_name, "file": file_name, "reason": str(exc)})
                continue

            summary = _relation_entry_summary(category_name, file_name, payload)
            score, signals = _relation_candidate_score(source_ref, source_payload, summary)
            if score <= 0:
                continue
            summary["signals"] = signals
            summary["_score"] = score
            candidates.append(summary)

    candidates.sort(
        key=lambda item: (
            -int(item.get("_score") or 0),
            str(item.get("category") or ""),
            str(item.get("word") or ""),
            str(item.get("file") or ""),
        )
    )
    final = []
    for item in candidates[:normalized_limit]:
        clean = dict(item)
        clean.pop("_score", None)
        final.append(clean)
    return final, skipped


def _build_relation_rule_suggestions(source_ref: dict, candidates: list[dict], existing_relations: list[dict], limit: int) -> list[dict]:
    existing_keys = {_relation_key(item) for item in existing_relations}
    source_key = _normalize_text_key(source_ref.get("word"))
    source_tokens = _relation_word_tokens(str(source_ref.get("word") or ""))
    suggestions = []
    seen = set()
    for candidate in candidates:
        target_ref = _build_entry_ref(
            str(candidate.get("category") or ""),
            str(candidate.get("file") or ""),
            str(candidate.get("word") or ""),
        )
        target_key = _normalize_text_key(target_ref.get("word"))
        target_tokens = _relation_word_tokens(str(target_ref.get("word") or ""))
        relation_type = ""
        reason = ""
        confidence = 0.0

        if source_key and source_key == target_key:
            relation_type = "same_word"
            reason = "不同目录中的同名词条，适合互相跳转。"
            confidence = 0.96
        elif _is_contiguous_subsequence(source_tokens, target_tokens) or _is_contiguous_subsequence(target_tokens, source_tokens):
            relation_type = "phrase"
            reason = "一个词条是另一个词条的固定短语或短语化扩展，适合建立跳转。"
            confidence = 0.84

        if not relation_type:
            continue
        key = (_entry_ref_id(target_ref), relation_type)
        if key in seen or key in existing_keys:
            continue
        seen.add(key)
        suggestions.append(
            {
                "type": relation_type,
                "target": target_ref,
                "reason": reason,
                "confidence": confidence,
                "source": "rule",
            }
        )
        if len(suggestions) >= max(1, int(limit or 12)):
            break
    return suggestions


def _normalize_relation_suggestion_for_response(item: dict, default_category: str, source_ref: dict) -> dict | None:
    relation = _normalize_relation_item(item, default_category, source_ref=source_ref)
    if not relation:
        return None
    target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
    if not _load_entry_by_ref(target_ref):
        return None
    try:
        confidence = round(_clamp_probability(item.get("confidence"), fallback=0.72), 3)
    except Exception:
        confidence = 0.72
    relation["confidence"] = confidence
    relation["source"] = str(item.get("source") or relation.get("source") or "llm").strip() or "llm"
    return relation


def _merge_relation_suggestions(
    heuristic_items: list[dict],
    llm_items: list[dict],
    default_category: str,
    source_ref: dict,
    existing_relations: list[dict],
    limit: int,
) -> list[dict]:
    existing_keys = {_relation_key(item) for item in existing_relations}
    merged = {}
    for raw_item in list(heuristic_items or []) + list(llm_items or []):
        if not isinstance(raw_item, dict):
            continue
        item = _normalize_relation_suggestion_for_response(raw_item, default_category, source_ref)
        if not item:
            continue
        key = _relation_key(item)
        if key in existing_keys:
            continue
        current = merged.get(key)
        if current is None or float(item.get("confidence") or 0.0) > float(current.get("confidence") or 0.0):
            merged[key] = item

    suggestions = list(merged.values())
    source_rank = {"llm": 0, "rule": 1}
    suggestions.sort(
        key=lambda item: (
            source_rank.get(str(item.get("source") or ""), 2),
            -float(item.get("confidence") or 0.0),
            str(item.get("target", {}).get("category") or ""),
            str(item.get("target", {}).get("word") or ""),
        )
    )
    return suggestions[: max(1, int(limit or 12))]


def _build_file_refine_llm_result(
    file_name: str,
    payload_for_analysis: dict,
    heuristic: dict,
    rule_suggestions: list[dict],
    *,
    include_llm: bool,
) -> tuple[dict | None, str | None]:
    llm = None
    llm_error = None

    if include_llm:
        try:
            logger.info("[refine_file] llm analyze start file=%s", file_name)
            llm = suggest_file_cleaning_with_llm(
                word=heuristic.get("word", ""),
                definitions=payload_for_analysis.get("definitions", []),
                examples=payload_for_analysis.get("examples", []),
                rule_suggestions=rule_suggestions,
            )
            logger.info(
                "[refine_file] llm analyze success file=%s def_items=%s ex_items=%s",
                file_name,
                len(llm.get("definitions", []) if isinstance(llm, dict) and isinstance(llm.get("definitions"), list) else []),
                len(llm.get("examples", []) if isinstance(llm, dict) and isinstance(llm.get("examples"), list) else []),
            )
        except Exception as exc:
            llm_error = str(exc)
            logger.exception("[refine_file] llm analyze failed file=%s: %s", file_name, exc)
    elif llm is None:
        llm = {"entry": [], "definitions": [], "examples": [], "global_notes": []}

    if isinstance(llm, dict):
        llm["entry"] = _merge_llm_entry_suggestions(
            llm.get("entry"),
            rule_suggestions,
        )

        missing_definitions = any(
            isinstance(item, dict) and item.get("type") == "definition_missing"
            for item in heuristic.get("suggestions", [])
        ) if isinstance(heuristic, dict) else False
        if include_llm and missing_definitions:
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
                    logger.exception("[refine_file] missing definition llm failed file=%s: %s", file_name, exc)

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
        if include_llm and missing_explanation_uncovered:
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
                logger.exception("[refine_file] missing explanation llm failed file=%s: %s", file_name, exc)

    return llm, llm_error


def _merge_llm_entry_suggestions(existing_items, rule_suggestions: list[dict]) -> list[dict]:
    merged = []
    seen = set()

    for raw_item in existing_items if isinstance(existing_items, list) else []:
        if not isinstance(raw_item, dict):
            continue
        action = str(raw_item.get("action") or "").strip().lower()
        suggested_word = _WS_RE.sub(" ", str(raw_item.get("suggested_word") or raw_item.get("target_word") or "")).strip()
        if action != "rename" or not suggested_word:
            continue
        key = (action, suggested_word.lower())
        if key in seen:
            continue
        seen.add(key)
        merged.append(raw_item)

    for raw_item in rule_suggestions if isinstance(rule_suggestions, list) else []:
        if not isinstance(raw_item, dict):
            continue
        if str(raw_item.get("source") or "").strip() != "lemma_rule":
            continue
        if str(raw_item.get("type") or "").strip() != "entry_lemma_merge":
            continue
        action = str(raw_item.get("action") or "").strip().lower()
        suggested_word = _WS_RE.sub(" ", str(raw_item.get("suggested_word") or "")).strip()
        if action != "rename" or not suggested_word:
            continue
        key = (action, suggested_word.lower())
        if key in seen:
            continue
        seen.add(key)
        merged.append(
            {
                "action": "rename",
                "suggested_word": suggested_word,
                "reason": str(raw_item.get("reason") or "规则识别：词形应归并到原型。").strip(),
                "confidence": _clamp_probability(raw_item.get("confidence"), fallback=0.93),
            }
        )

    return merged


def _build_file_refine_response(
    *,
    category: str,
    file_name: str,
    payload_for_analysis: dict,
    analyzed_from: str,
    include_llm: bool,
    use_cache: bool,
    refresh_cache: bool,
) -> dict:
    heuristic = analyze_file_cleaning_suggestions(file_name, payload_for_analysis)
    logger.info(
        "[refine_file] heuristic done file=%s suggestion_count=%s analyzed_from=%s",
        file_name,
        len(heuristic.get("suggestions", []) if isinstance(heuristic, dict) else []),
        analyzed_from,
    )
    entry_rule_hints = suggest_entry_quality_with_rules(
        word=heuristic.get("word", ""),
        definitions=payload_for_analysis.get("definitions", []),
        examples=payload_for_analysis.get("examples", []),
    )
    rule_suggestions = list(heuristic.get("suggestions", []) if isinstance(heuristic, dict) else [])
    rule_suggestions.extend(entry_rule_hints)

    cache_meta = build_refine_cache_key(category, file_name, payload_for_analysis)
    can_use_cache = bool(include_llm and use_cache and analyzed_from == "file")
    cache_status = "disabled"
    llm = None
    llm_error = None

    if can_use_cache and not refresh_cache:
        cached = load_refine_cache(cache_meta)
        cached_llm = cached.get("llm") if isinstance(cached, dict) else None
        cached_error = cached.get("llm_error") if isinstance(cached, dict) else None
        if isinstance(cached_llm, dict) and not cached_error:
            llm = cached_llm
            llm_error = None
            cache_status = "hit"
        else:
            cache_status = "miss"
    elif can_use_cache and refresh_cache:
        cache_status = "refresh"

    if llm is None and cache_status != "hit":
        llm, llm_error = _build_file_refine_llm_result(
            file_name,
            payload_for_analysis,
            heuristic,
            rule_suggestions,
            include_llm=include_llm,
        )
        if can_use_cache and isinstance(llm, dict) and not llm_error:
            save_refine_cache(cache_meta, llm, llm_error)
            cache_status = "stored"
        elif can_use_cache and llm_error:
            cache_status = "error"

    logger.info(
        "[refine_file] done file=%s llm_error=%s cache=%s",
        file_name,
        bool(llm_error),
        cache_status,
    )
    return {
        "status": "success",
        "category": category,
        "file": file_name,
        "analyzed_from": analyzed_from,
        "heuristic": heuristic,
        "llm": llm,
        "llm_error": llm_error,
        "cache": {
            "status": cache_status,
            "enabled": can_use_cache,
            "cache_key": cache_meta.get("cache_key"),
            "content_hash": cache_meta.get("content_hash"),
        },
    }


@router.get("/api/health")
def health_check():
    return {"status": "ok"}


@router.get("/api/review/visualization")
def review_visualization(
    category: str | None = None,
    graph_limit: int = _DEFAULT_RELATION_GRAPH_COMPONENT_LIMIT,
    graph_random: bool = False,
    graph_seed: str | None = None,
):
    try:
        today = date.today()
        selected_category = str(category or "").strip()
        all_categories = list_categories()
        scoped_categories = [selected_category] if selected_category else all_categories
        graph_component_limit = _safe_int_range(
            graph_limit,
            _DEFAULT_RELATION_GRAPH_COMPONENT_LIMIT,
            1,
            20,
        )
        recommendation_preferences = _build_recommendation_preferences_from_values()

        category_summaries = {}
        global_counts = {
            "total": 0,
            "marked": 0,
            "reviewed": 0,
            "today_reviewed": 0,
        }
        global_bucket_counts = Counter()
        global_status_counts = Counter()
        global_feature_counts = Counter()
        global_daily_review_counts = Counter()
        global_created_month_counts = Counter()
        selected_entries = []
        skipped = []
        graph_nodes_by_id = {}
        graph_raw_edges = []
        graph_word_index: dict[str, list[str]] = defaultdict(list)

        for category_name in all_categories:
            category_counts = {
                "total": 0,
                "marked": 0,
                "reviewed": 0,
                "today_reviewed": 0,
            }
            category_bucket_counts = Counter()
            category_status_counts = Counter()
            category_feature_counts = Counter()
            category_today_feature_counts = Counter()
            category_daily_review_counts = Counter()
            category_latest_entries = []
            category_recently_added_entries = []

            try:
                files = list_vocab_files(category_name)
            except Exception as exc:
                skipped.append({"category": category_name, "reason": str(exc)})
                category_summaries[category_name] = {
                    "category": category_name,
                    "total": 0,
                    "counts": category_counts,
                    "mastery": [],
                    "review_status": [],
                    "today_feature_share": [],
                    "latest_reviews": [],
                    "recently_added": [],
                    "error": str(exc),
                }
                continue

            for path in files:
                file_name = os.path.basename(path)
                try:
                    payload = load_vocab_file(path)
                except Exception as exc:
                    skipped.append({"category": category_name, "file": file_name, "reason": str(exc)})
                    continue

                fallback_word = os.path.splitext(file_name)[0]
                word = str(payload.get("word") or fallback_word).strip() or fallback_word
                reviews = _safe_reviews(payload.get("reviews"))
                latest_review = reviews[-1] if reviews else None
                latest_score = latest_review.get("score") if latest_review else None
                bucket = _score_bucket(latest_score)
                advice = build_review_advice(reviews, today=today)
                status = str(advice.get("status") or "unknown")
                created_at = _safe_created_at(payload.get("createdAt"))
                score_result = _build_review_candidate_score(
                    advice,
                    created_at,
                    today,
                    recommendation_preferences,
                )
                feature_flags = _entry_example_feature_flags(payload)
                marked = bool(payload.get("marked", False))
                reviewed_today = any(review.get("date") == format_review_date(today) for review in reviews)

                category_counts["total"] += 1
                category_counts["marked"] += int(marked)
                category_counts["reviewed"] += int(bool(reviews))
                category_counts["today_reviewed"] += int(reviewed_today)
                category_bucket_counts[bucket] += 1
                category_status_counts[status] += 1
                for key, enabled in feature_flags.items():
                    category_feature_counts[key] += int(enabled)
                    if reviewed_today:
                        category_today_feature_counts[key] += int(enabled)
                category_feature_counts["marked"] += int(marked)
                if reviewed_today:
                    category_today_feature_counts["marked"] += int(marked)

                if created_at:
                    try:
                        category_created_day = parse_review_date(created_at)
                        global_created_month_counts[_format_month_key(category_created_day)] += 1
                    except Exception:
                        pass

                for review in reviews:
                    review_date = str(review.get("date") or "").strip()
                    if review_date:
                        category_daily_review_counts[review_date] += 1

                entry_summary = {
                    "category": category_name,
                    "file": file_name,
                    "word": word,
                    "marked": marked,
                    "created_at": created_at,
                    "latest_review": latest_review,
                    "latest_score": latest_score,
                    "mastery_bucket": bucket,
                    "mastery_label": _score_bucket_label(bucket),
                    "review_status": status,
                    "review_status_label": _review_status_label(status),
                    "review_count": len(reviews),
                    "next_review_date": advice.get("next_review_date"),
                    "days_until_due": advice.get("days_until_due"),
                    "priority_score": score_result["priority_score"],
                    "score_breakdown": score_result["score_breakdown"],
                    "feature_flags": feature_flags,
                    "reviewed_today": reviewed_today,
                }
                node_ref = _build_entry_ref(category_name, file_name, word)
                node_id = _entry_ref_id(node_ref)
                graph_nodes_by_id[node_id] = {
                    "id": node_id,
                    "category": category_name,
                    "file": file_name,
                    "word": word,
                    "marked": marked,
                    "created_at": created_at,
                    "review_status": status,
                    "review_status_label": _review_status_label(status),
                    "mastery_bucket": bucket,
                    "mastery_label": _score_bucket_label(bucket),
                    "review_count": len(reviews),
                    "latest_review": latest_review,
                    "latest_score": latest_score,
                    "next_review_date": advice.get("next_review_date"),
                    "days_until_due": advice.get("days_until_due"),
                    "review_priority_score": score_result["priority_score"],
                    "review_score_breakdown": score_result["score_breakdown"],
                }
                graph_word_index[_normalize_text_key(word)].append(node_id)

                relations = _normalize_relations(payload, category_name, source_ref=node_ref)
                for relation in relations:
                    target_ref = relation.get("target") if isinstance(relation.get("target"), dict) else {}
                    target_id = _entry_ref_id(target_ref)
                    graph_raw_edges.append(
                        {
                            "source": node_id,
                            "target": target_id,
                            "type": str(relation.get("type") or "related"),
                            "reason": str(relation.get("reason") or ""),
                            "source_kind": str(relation.get("source") or "json"),
                        }
                    )

                if category_name in scoped_categories:
                    selected_entries.append(entry_summary)

                if latest_review:
                    category_latest_entries.append(entry_summary)
                if created_at:
                    category_recently_added_entries.append(entry_summary)

            category_latest_entries.sort(
                key=lambda item: (
                    str(item.get("latest_review", {}).get("date") or ""),
                    str(item.get("word") or ""),
                ),
                reverse=True,
            )
            category_recently_added_entries.sort(
                key=lambda item: (
                    str(item.get("created_at") or ""),
                    str(item.get("word") or ""),
                ),
                reverse=True,
            )

            category_summaries[category_name] = {
                "category": category_name,
                "total": category_counts["total"],
                "counts": category_counts,
                "mastery": [
                    {
                        "key": key,
                        "label": _score_bucket_label(key),
                        "count": category_bucket_counts.get(key, 0),
                    }
                    for key in ("mastered", "familiar", "unfamiliar", "unreviewed")
                ],
                "review_status": [
                    {
                        "key": key,
                        "label": _review_status_label(key),
                        "count": category_status_counts.get(key, 0),
                    }
                    for key in ("overdue", "due_today", "due_soon", "scheduled", "new")
                ],
                "today_feature_share": _build_feature_share_items(category_today_feature_counts, category_counts["today_reviewed"]),
                "feature_share": _build_feature_share_items(category_feature_counts, category_counts["total"]),
                "latest_reviews": category_latest_entries[:8],
                "recently_added": category_recently_added_entries[:8],
            }

            for key, value in category_counts.items():
                global_counts[key] += value
            global_bucket_counts.update(category_bucket_counts)
            global_status_counts.update(category_status_counts)
            global_feature_counts.update(category_feature_counts)
            global_daily_review_counts.update(category_daily_review_counts)

        selected_total = len(selected_entries)
        selected_counts = {
            "total": selected_total,
            "marked": sum(1 for item in selected_entries if item.get("marked")),
            "reviewed": sum(1 for item in selected_entries if item.get("review_count", 0) > 0),
            "today_reviewed": sum(1 for item in selected_entries if item.get("reviewed_today")),
        }
        selected_bucket_counts = Counter(item.get("mastery_bucket") for item in selected_entries)
        selected_status_counts = Counter(item.get("review_status") for item in selected_entries)
        selected_feature_counts = Counter()
        selected_today_feature_counts = Counter()
        due_entries = []
        latest_selected_reviews = []
        recently_added_entries = []

        for item in selected_entries:
            flags = item.get("feature_flags") if isinstance(item.get("feature_flags"), dict) else {}
            for key, enabled in flags.items():
                selected_feature_counts[key] += int(enabled)
                if item.get("reviewed_today"):
                    selected_today_feature_counts[key] += int(enabled)
            selected_feature_counts["marked"] += int(bool(item.get("marked")))
            if item.get("reviewed_today"):
                selected_today_feature_counts["marked"] += int(bool(item.get("marked")))
            if item.get("review_status") in {"overdue", "due_today", "due_soon", "new"}:
                due_entries.append(item)
            if item.get("latest_review"):
                latest_selected_reviews.append(item)
            if item.get("created_at"):
                recently_added_entries.append(item)

        due_entries.sort(
            key=lambda item: (
                int(item.get("days_until_due") if item.get("days_until_due") is not None else 10_000),
                str(item.get("word") or ""),
            )
        )
        latest_selected_reviews.sort(
            key=lambda item: (
                str(item.get("latest_review", {}).get("date") or ""),
                str(item.get("word") or ""),
            ),
            reverse=True,
        )
        recently_added_entries.sort(
            key=lambda item: (
                str(item.get("created_at") or ""),
                str(item.get("word") or ""),
            ),
            reverse=True,
        )

        daily_review_trend = _default_daily_review_counts(today, days=14)
        for item in daily_review_trend:
            item["count"] = int(global_daily_review_counts.get(item["date"], 0))

        category_rank = sorted(
            [
                {
                    "category": name,
                    "total": summary.get("total", 0),
                    "today_reviewed": summary.get("counts", {}).get("today_reviewed", 0),
                    "marked": summary.get("counts", {}).get("marked", 0),
                }
                for name, summary in category_summaries.items()
            ],
            key=lambda item: (-int(item.get("total") or 0), item.get("category", "")),
        )

        created_month_trend = [
            {"month": key, "count": global_created_month_counts[key]}
            for key in sorted(global_created_month_counts.keys())[-12:]
        ]
        for word_key, node_ids in graph_word_index.items():
            unique_ids = sorted(set(node_ids))
            if not word_key or len(unique_ids) < 2:
                continue
            for source_id, target_id in combinations(unique_ids, 2):
                graph_raw_edges.append(
                    {
                        "source": source_id,
                        "target": target_id,
                        "type": "same_word",
                        "reason": "不同目录中的同名词条",
                        "source_kind": "auto",
                    }
                )

        graph_category_set = set(scoped_categories)
        scoped_graph_nodes_by_id = {
            node_id: node
            for node_id, node in graph_nodes_by_id.items()
            if not selected_category or str(node.get("category") or "") in graph_category_set
        }
        full_relation_graph = _build_relation_graph(scoped_graph_nodes_by_id, graph_raw_edges)
        _rank_relation_graph_components_by_review_value(full_relation_graph)
        relation_graph = _select_relation_graph_components(
            full_relation_graph,
            limit=graph_component_limit,
            randomize=bool(graph_random),
            seed=graph_seed,
        )
        relation_graph["scope"] = {
            "category": selected_category,
            "label": selected_category or "全部目录",
        }

        return {
            "status": "success",
            "category": selected_category,
            "generated_at": format_review_date(today),
            "categories": all_categories,
            "overview": {
                "counts": global_counts,
                "mastery": [
                    {
                        "key": key,
                        "label": _score_bucket_label(key),
                        "count": global_bucket_counts.get(key, 0),
                    }
                    for key in ("mastered", "familiar", "unfamiliar", "unreviewed")
                ],
                "review_status": [
                    {
                        "key": key,
                        "label": _review_status_label(key),
                        "count": global_status_counts.get(key, 0),
                    }
                    for key in ("overdue", "due_today", "due_soon", "scheduled", "new")
                ],
                "feature_share": _build_feature_share_items(global_feature_counts, global_counts["total"]),
                "daily_review_trend": daily_review_trend,
                "created_month_trend": created_month_trend,
                "category_rank": category_rank,
            },
            "selected": {
                "category": selected_category,
                "label": selected_category or "全部目录",
                "counts": selected_counts,
                "mastery": [
                    {
                        "key": key,
                        "label": _score_bucket_label(key),
                        "count": selected_bucket_counts.get(key, 0),
                    }
                    for key in ("mastered", "familiar", "unfamiliar", "unreviewed")
                ],
                "review_status": [
                    {
                        "key": key,
                        "label": _review_status_label(key),
                        "count": selected_status_counts.get(key, 0),
                    }
                    for key in ("overdue", "due_today", "due_soon", "scheduled", "new")
                ],
                "feature_share": _build_feature_share_items(selected_feature_counts, selected_total),
                "today_feature_share": _build_feature_share_items(
                    selected_today_feature_counts,
                    selected_counts["today_reviewed"],
                ),
                "due_entries": due_entries[:10],
                "latest_reviews": latest_selected_reviews[:10],
                "recently_added": recently_added_entries[:10],
            },
            "category_summaries": category_summaries,
            "graph": relation_graph,
            "meta": {
                "scanned_categories": len(all_categories),
                "scanned_files": global_counts["total"],
                "skipped": skipped,
                "graph": {
                    "selection": relation_graph.get("selection", {}),
                    "component_limit": graph_component_limit,
                    "available_component_count": relation_graph.get("available_component_count", 0),
                    "recommended_component_count": relation_graph.get("recommended_component_count", 0),
                    "selection_mode": relation_graph.get("selection", {}).get("mode", "recommended"),
                    "preferences": recommendation_preferences,
                },
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/vocabulary/relations/suggest")
def suggest_vocab_relations(req: RelationSuggestRequest):
    try:
        category = _require_category(req.category)
        path, existing = load_vocab_entry(category, req.filename)
        file_name = os.path.basename(path)
        fallback_word = os.path.splitext(file_name)[0]
        source_payload = _normalize_vocab_payload(
            req.data if isinstance(req.data, dict) else existing,
            fallback_word=fallback_word,
            fallback_created_at=str(existing.get("createdAt", "")),
            category=category,
            filename=file_name,
        )
        source_ref = _build_entry_ref(category, file_name, source_payload.get("word") or fallback_word)
        existing_relations = _normalize_relations(source_payload, category, source_ref=source_ref)
        existing_relation_keys = {_relation_key(item) for item in existing_relations}
        for incoming_relation in _find_incoming_relations(source_ref):
            if _relation_key(incoming_relation) not in existing_relation_keys:
                existing_relations.append(incoming_relation)
                existing_relation_keys.add(_relation_key(incoming_relation))
        normalized_limit = max(1, min(int(req.limit or 12), 30))
        rule_candidates, rule_skipped = _build_relation_candidates(
            source_ref,
            source_payload,
            candidate_limit=req.candidate_limit,
        )
        heuristic = _build_relation_rule_suggestions(
            source_ref,
            rule_candidates,
            existing_relations,
            limit=normalized_limit,
        )

        llm_result = {"suggestions": [], "notes": []}
        llm_selection = {"selected": {}, "notes": []}
        llm_error = None
        vocabulary_index, compact_candidate_by_id, index_skipped = _build_compact_vocabulary_index(source_ref)
        skipped = rule_skipped + index_skipped
        selected_candidate_refs = []
        if vocabulary_index:
            try:
                logger.info(
                    "[relations_suggest] llm select start file=%s categories=%s candidates=%s",
                    file_name,
                    len(vocabulary_index),
                    len(compact_candidate_by_id),
                )
                llm_selection = select_vocab_relation_candidates_with_llm(
                    source={
                        **_relation_entry_summary(category, file_name, source_payload),
                        "category": category,
                        "file": file_name,
                    },
                    vocabulary_index=vocabulary_index,
                    existing_relations=existing_relations,
                    limit=5,
                )
                selected_candidate_refs = _candidate_refs_from_words(
                    llm_selection.get("selected", {}) if isinstance(llm_selection, dict) else {},
                    compact_candidate_by_id,
                    fallback_category=category,
                    limit=5,
                )
                logger.info(
                    "[relations_suggest] llm select success file=%s selected=%s",
                    file_name,
                    len(selected_candidate_refs),
                )
            except Exception as exc:
                llm_error = str(exc)
                logger.exception("[relations_suggest] llm select failed file=%s: %s", file_name, exc)

        llm_candidates, llm_candidate_skipped = _load_relation_candidate_summaries(
            selected_candidate_refs,
            source_ref,
            source_payload,
        )
        skipped.extend(llm_candidate_skipped)
        if llm_candidates:
            try:
                logger.info(
                    "[relations_suggest] llm confirm start file=%s candidates=%s",
                    file_name,
                    len(llm_candidates),
                )
                llm_result = suggest_vocab_relations_with_llm(
                    source={
                        **_relation_entry_summary(category, file_name, source_payload),
                        "category": category,
                        "file": file_name,
                    },
                    candidates=llm_candidates,
                    existing_relations=existing_relations,
                    limit=normalized_limit,
                )
                logger.info(
                    "[relations_suggest] llm confirm success file=%s suggestion_count=%s",
                    file_name,
                    len(llm_result.get("suggestions", []) if isinstance(llm_result, dict) else []),
                )
            except Exception as exc:
                llm_error = str(exc) if not llm_error else f"{llm_error}; {exc}"
                logger.exception("[relations_suggest] llm confirm failed file=%s: %s", file_name, exc)

        suggestions = _merge_relation_suggestions(
            heuristic,
            llm_result.get("suggestions", []) if isinstance(llm_result, dict) else [],
            category,
            source_ref,
            existing_relations,
            limit=normalized_limit,
        )

        return {
            "status": "success",
            "category": category,
            "file": file_name,
            "source": source_ref,
            "suggestions": suggestions,
            "heuristic": {"suggestions": heuristic},
            "llm": {
                **(llm_result if isinstance(llm_result, dict) else {"suggestions": [], "notes": []}),
                "selection": llm_selection,
            },
            "llm_error": llm_error,
            "notes": (
                (llm_selection.get("notes", []) if isinstance(llm_selection, dict) else [])
                + (llm_result.get("notes", []) if isinstance(llm_result, dict) else [])
            ),
            "meta": {
                "candidate_count": len(llm_candidates),
                "full_vocabulary_candidate_count": len(compact_candidate_by_id),
                "rule_candidate_count": len(rule_candidates),
                "candidate_limit": max(12, min(int(req.candidate_limit or 72), 180)),
                "llm_selected_count": len(selected_candidate_refs),
                "skipped": skipped,
            },
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


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
            category=category,
            filename=os.path.basename(path),
        )
        save_vocab_file(path, normalized)
        _sync_bidirectional_relations_for_entry(
            category,
            os.path.basename(path),
            existing,
            normalized,
        )
        _delete_refine_cache_if_analysis_changed(
            category,
            os.path.basename(path),
            existing,
            normalized,
        )

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

        target_display_word = _normalize_vocab_display_word(req.word)
        if not target_display_word:
            raise ValueError("word 不能为空")
        target_filename = _build_vocab_filename(target_display_word)
        target_path = resolve_vocab_file_for_write(category, target_filename)
        same_target = os.path.abspath(target_path) == os.path.abspath(source_path)

        payload_source = req.data if isinstance(req.data, dict) else existing
        normalized = _normalize_vocab_payload(
            payload_source,
            fallback_word=target_display_word,
            fallback_created_at=str(existing.get("createdAt", "")),
            category=category,
            filename=target_filename,
        )
        normalized = _rewrite_vocab_word_references(
            normalized,
            source_words={
                source_word,
                os.path.splitext(source_file)[0],
                str(req.filename or ""),
            },
            target_word=target_display_word,
        )
        target_existed = bool(not same_target and os.path.exists(target_path))
        if target_existed:
            target_payload = load_vocab_file(target_path)
            normalized["word"] = source_word
            normalized = _merge_vocab_payload(
                target_payload=target_payload,
                source_payload=normalized,
                target_fallback_word=target_display_word,
                target_category=category,
                target_filename=target_filename,
                source_category=category,
                source_filename=source_file,
            )
            source_ref = _build_entry_ref(category, source_file, source_word)
            target_ref = _build_entry_ref(category, target_filename, normalized.get("word") or target_display_word)
            normalized, rewritten_relation_files = _finalize_vocab_merge_relations(
                source_ref=source_ref,
                target_ref=target_ref,
                merged_payload=normalized,
            )
        else:
            rewritten_relation_files = 0
        save_vocab_file(target_path, normalized)
        _sync_bidirectional_relations_for_entry(
            category,
            os.path.basename(target_path),
            existing,
            normalized,
            before_filename=source_file,
        )
        delete_refine_cache_for_entry(category, source_file)
        delete_refine_cache_for_entry(category, os.path.basename(target_path))

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
            "word": target_display_word,
            "data": normalized,
            "target_existed": target_existed,
            "merged_to_existing": target_existed,
            "rewritten_relation_files": rewritten_relation_files,
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
            target_category=category,
            target_filename=os.path.basename(target_path),
            source_category=category,
            source_filename=os.path.basename(source_path),
        )
        source_ref = _build_entry_ref(category, os.path.basename(source_path), source_payload.get("word") or os.path.splitext(os.path.basename(source_path))[0])
        target_ref = _build_entry_ref(category, os.path.basename(target_path), merged_payload.get("word") or os.path.splitext(os.path.basename(target_path))[0])
        merged_payload, rewritten_relation_files = _finalize_vocab_merge_relations(
            source_ref=source_ref,
            target_ref=target_ref,
            merged_payload=merged_payload,
        )
        save_vocab_file(target_path, merged_payload)
        _sync_bidirectional_relations_for_entry(
            category,
            os.path.basename(target_path),
            target_payload if isinstance(target_payload, dict) else {},
            merged_payload,
        )
        delete_refine_cache_for_entry(category, os.path.basename(source_path))
        delete_refine_cache_for_entry(category, os.path.basename(target_path))

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
            "rewritten_relation_files": rewritten_relation_files,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/vocabulary/merge/manual")
def manual_merge_vocab(req: ManualVocabMergeRequest):
    try:
        source_category = _require_category(req.source_category)
        target_category = _require_category(req.target_category)
        source_path, existing_source = load_vocab_entry(source_category, req.source_filename)
        source_file = os.path.basename(source_path)
        source_word = _normalize_vocab_display_word(
            existing_source.get("word") or os.path.splitext(source_file)[0]
        ) or os.path.splitext(source_file)[0]

        target_word = _normalize_vocab_display_word(req.target_word)
        target_filename = _normalize_json_filename(req.target_filename) if req.target_filename else ""
        if target_word:
            target_filename = _build_vocab_filename(target_word)
        elif target_filename:
            target_word = os.path.splitext(target_filename)[0]
        else:
            raise ValueError("target_word 或 target_filename 不能为空")

        source_payload = _normalize_vocab_payload(
            req.source_data if isinstance(req.source_data, dict) else existing_source,
            fallback_word=source_word,
            fallback_created_at=str(existing_source.get("createdAt", "")),
            category=source_category,
            filename=source_file,
        )

        target_path = resolve_vocab_file_for_write(target_category, target_filename)
        same_target = os.path.abspath(source_path) == os.path.abspath(target_path)
        if same_target:
            raise ValueError("不能将词条合并到自身")

        target_exists = os.path.exists(target_path)
        if target_exists:
            target_payload = load_vocab_file(target_path)
            target_fallback_word = str(target_payload.get("word") or os.path.splitext(target_filename)[0]).strip()
        elif req.create_target_if_missing:
            target_payload = {}
            target_fallback_word = target_word or os.path.splitext(target_filename)[0]
        else:
            raise FileNotFoundError(f"词条文件不存在: {target_filename}")

        merged_payload = _merge_vocab_payload(
            target_payload=target_payload,
            source_payload=source_payload,
            target_fallback_word=target_fallback_word,
            target_category=target_category,
            target_filename=target_filename,
            source_category=source_category,
            source_filename=source_file,
        )
        if not target_exists and target_word:
            merged_payload["word"] = target_word
        source_ref = _build_entry_ref(source_category, source_file, source_word)
        target_ref = _build_entry_ref(target_category, target_filename, merged_payload.get("word") or target_word or target_fallback_word)
        merged_payload, rewritten_relation_files = _finalize_vocab_merge_relations(
            source_ref=source_ref,
            target_ref=target_ref,
            merged_payload=merged_payload,
        )

        save_vocab_file(target_path, merged_payload)
        _sync_bidirectional_relations_for_entry(
            target_category,
            os.path.basename(target_path),
            target_payload if isinstance(target_payload, dict) else {},
            merged_payload,
        )
        delete_refine_cache_for_entry(source_category, source_file)
        delete_refine_cache_for_entry(target_category, os.path.basename(target_path))

        source_deleted = False
        if req.delete_source:
            try:
                os.remove(source_path)
                source_deleted = True
            except FileNotFoundError:
                source_deleted = False

        return {
            "status": "success",
            "source_category": source_category,
            "source_file": source_file,
            "source_word": source_word,
            "target_category": target_category,
            "target_file": os.path.basename(target_path),
            "target_word": str(merged_payload.get("word") or target_word or target_fallback_word).strip(),
            "target_created": not target_exists,
            "source_deleted": source_deleted,
            "data": merged_payload,
            "rewritten_relation_files": rewritten_relation_files,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/refine/split/apply")
def apply_split(req: SplitApplyRequest):
    raise HTTPException(status_code=410, detail="词条拆分功能已移除")
    try:
        category = _require_category(req.category)
        source_path, existing = load_vocab_entry(category, req.source_filename)
        source_file = os.path.basename(source_path)
        source_word = str(existing.get("word") or os.path.splitext(source_file)[0]).strip() or os.path.splitext(source_file)[0]
        source_payload = _normalize_vocab_payload(
            req.data if isinstance(req.data, dict) else existing,
            fallback_word=source_word,
            fallback_created_at=str(existing.get("createdAt", "")),
            category=category,
            filename=source_file,
        )
        split_entries = _normalize_split_apply_entries(req.suggestion)
        if not split_entries:
            raise ValueError("拆分建议为空")

        source_examples = source_payload.get("examples") if isinstance(source_payload.get("examples"), list) else []
        source_created_at = str(source_payload.get("createdAt") or existing.get("createdAt") or "")
        source_reason = str(req.suggestion.get("reason") or "").strip() if isinstance(req.suggestion, dict) else ""
        created_files = []
        updated_files = []
        split_refs = []
        source_retained = False

        for split_entry in split_entries:
            target_word = split_entry["word"]
            target_filename = _build_vocab_filename(target_word)
            target_path = resolve_vocab_file_for_write(category, target_filename)
            same_as_source = os.path.abspath(target_path) == os.path.abspath(source_path)
            target_exists = os.path.exists(target_path) and not same_as_source
            target_payload = load_vocab_file(target_path) if target_exists else {}
            addition_payload = {
                "word": target_word,
                "createdAt": source_created_at,
                "reviews": source_payload.get("reviews", []) if same_as_source else [],
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
                target_category=category,
                target_filename=target_filename,
            )
            save_vocab_file(target_path, merged_payload)
            delete_refine_cache_for_entry(category, os.path.basename(target_path))
            target_ref = _build_entry_ref(category, os.path.basename(target_path), merged_payload.get("word") or target_word)
            split_refs.append(target_ref)
            if same_as_source:
                source_retained = True

            item = {
                "file": os.path.basename(target_path),
                "word": target_word,
                "data": merged_payload,
                "created": not target_exists and not same_as_source,
            }
            if target_exists or same_as_source:
                updated_files.append(item)
            else:
                created_files.append(item)

        relation_reason = source_reason or "由同一词条拆分产生"
        for left_ref, right_ref in combinations(split_refs, 2):
            _ensure_bidirectional_relation(
                left_ref,
                right_ref,
                relation_type="split",
                reason=relation_reason,
                origin="split",
            )

        refreshed_items = []
        for item in created_files + updated_files:
            loaded = _load_entry_by_ref(_build_entry_ref(category, item["file"], item["word"]))
            if loaded:
                _, payload = loaded
                item["data"] = payload
            refreshed_items.append(item)

        if req.delete_source and not source_retained:
            try:
                os.remove(source_path)
            except FileNotFoundError:
                pass
            delete_refine_cache_for_entry(category, source_file)

        return {
            "status": "success",
            "category": category,
            "source_file": source_file,
            "source_deleted": bool(req.delete_source and not source_retained),
            "created_files": created_files,
            "updated_files": updated_files,
            "entries": refreshed_items,
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
            "[refine_file] start category=%s filename=%s include_llm=%s has_draft=%s use_cache=%s refresh_cache=%s",
            category,
            req.filename,
            req.include_llm,
            isinstance(req.data, dict),
            req.use_cache,
            req.refresh_cache,
        )
        path, payload = load_vocab_entry(category, req.filename)
        fallback_word = os.path.splitext(os.path.basename(path))[0]
        file_name = os.path.basename(path)

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

        return _build_file_refine_response(
            category=category,
            file_name=file_name,
            payload_for_analysis=payload_for_analysis,
            analyzed_from=analyzed_from,
            include_llm=req.include_llm,
            use_cache=req.use_cache,
            refresh_cache=req.refresh_cache,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/refine/file/prefetch")
def prefetch_file_refine(req: FileRefinePrefetchRequest):
    try:
        category = _require_category(req.category)
        limit = min(max(int(req.limit or 20), 1), 50)
        filenames = []
        seen = set()
        for raw_filename in req.filenames or []:
            normalized = _normalize_json_filename(raw_filename)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            filenames.append(normalized)
            if len(filenames) >= limit:
                break

        results = []
        counts = Counter()
        for filename in filenames:
            try:
                path, payload = load_vocab_entry(category, filename)
                file_name = os.path.basename(path)
                result = _build_file_refine_response(
                    category=category,
                    file_name=file_name,
                    payload_for_analysis=payload,
                    analyzed_from="file",
                    include_llm=True,
                    use_cache=True,
                    refresh_cache=bool(req.refresh_cache),
                )
                cache_status = str(result.get("cache", {}).get("status") or "")
                counts[cache_status] += 1
                results.append(
                    {
                        "file": file_name,
                        "status": "success",
                        "cache": result.get("cache"),
                        "llm_error": result.get("llm_error"),
                    }
                )
            except Exception as exc:
                counts["error"] += 1
                results.append(
                    {
                        "file": filename,
                        "status": "error",
                        "error": str(exc),
                    }
                )

        return {
            "status": "success",
            "category": category,
            "requested": len(req.filenames or []),
            "processed": len(results),
            "limit": limit,
            "counts": dict(counts),
            "results": results,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


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
        mark_filter = _normalize_recommendation_mark_filter(req.mark_filter)
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

                marked = bool(payload.get("marked", False))
                needs_processing = vocabulary_entry_needs_processing(payload)
                if mark_filter == "marked" and not marked:
                    continue
                if mark_filter == "unmarked" and marked:
                    continue
                if mark_filter == "needs_processing" and not needs_processing:
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
                        "marked": marked,
                        "needs_processing": needs_processing,
                        "needsProcessing": needs_processing,
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
                "mark_filter": mark_filter,
                "skipped": skipped,
                "generated_at": format_review_date(today),
                "preferences": preferences,
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
