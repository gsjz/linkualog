from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from services.lemma_dictionary import get_lemma_words

TOKEN_PATTERN = re.compile(r"\s+|[\w]+|[^\w\s]", flags=re.UNICODE)
LETTER_WORD_PATTERN = re.compile(r"^[a-z]+$")
NON_ALPHA_PATTERN = re.compile(r"[^a-z]+")
CREATE_TARGET_CONFIDENCE_THRESHOLD = 0.80


@dataclass
class VocabEntry:
    file_path: str
    file_name: str
    word: str
    token: str | None
    definitions: list[str]
    examples: list[dict]
    reviews: list[dict]


def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _normalize_text_for_similarity(text: str) -> str:
    text = _collapse_ws(text).lower()
    text = text.replace("’", "'").replace("`", "'")
    return text


def _normalize_definition_key(text: str) -> str:
    text = _normalize_text_for_similarity(text)
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def _surface_word_token(text: str) -> str | None:
    token = NON_ALPHA_PATTERN.sub("", _normalize_text_for_similarity(text))
    if not token:
        return None
    if not LETTER_WORD_PATTERN.match(token):
        return None
    return token


def _tokenize_non_space(text: str) -> list[str]:
    return [token for token in TOKEN_PATTERN.findall(str(text or "")) if not token.isspace()]


def _clean_word_token(raw_word: str) -> str | None:
    word = _normalize_text_for_similarity(raw_word)
    if not LETTER_WORD_PATTERN.match(word):
        return None
    return word


def _append_candidate(candidates: list[str], value: str, source_word: str) -> None:
    if value == source_word:
        return
    if len(value) < 3:
        return
    if not LETTER_WORD_PATTERN.match(value):
        return
    if value not in candidates:
        candidates.append(value)


def _is_word_variant_match(base_word: str, candidate_word: str) -> bool:
    if not base_word or not candidate_word:
        return False
    if base_word == candidate_word:
        return True
    if base_word in _base_candidates(candidate_word):
        return True
    if candidate_word in _base_candidates(base_word):
        return True
    return False


def _base_candidates(word: str) -> list[str]:
    candidates: list[str] = []
    is_ied_form = word.endswith("ied") and len(word) > 4
    is_ies_form = word.endswith("ies") and len(word) > 4

    if is_ied_form:
        _append_candidate(candidates, word[:-3] + "y", word)

    if is_ies_form:
        _append_candidate(candidates, word[:-3] + "y", word)

    if word.endswith("ing") and len(word) > 5:
        stem = word[:-3]
        _append_candidate(candidates, stem, word)
        _append_candidate(candidates, stem + "e", word)
        if len(stem) > 2 and stem[-1] == stem[-2]:
            _append_candidate(candidates, stem[:-1], word)

    if word.endswith("ed") and len(word) > 4 and not is_ied_form:
        stem = word[:-2]
        _append_candidate(candidates, stem, word)
        _append_candidate(candidates, stem + "e", word)
        if len(stem) > 2 and stem[-1] == stem[-2]:
            _append_candidate(candidates, stem[:-1], word)

    if word.endswith("es") and len(word) > 4 and not is_ies_form:
        _append_candidate(candidates, word[:-2], word)

    if word.endswith("s") and len(word) > 3 and not is_ies_form:
        _append_candidate(candidates, word[:-1], word)

    return candidates


def _append_unique(values: list[str], candidate: str) -> None:
    if candidate and candidate not in values:
        values.append(candidate)


def _looks_like_double_consonant(token: str) -> bool:
    return len(token) >= 2 and token[-1] == token[-2] and token[-1] not in "aeiou"


def _should_ing_add_e(stem: str) -> bool:
    if len(stem) < 2:
        return False
    if stem.endswith("at") and len(stem) > 4 and stem[-3] not in "aeiou":
        return True
    if stem.endswith(("ng", "rk", "lk", "nk", "ck", "sk", "sh", "ch")):
        return False
    if stem[-1] not in {"k", "v", "z", "s", "r", "c", "g"}:
        return False
    return stem[-2] in "aeiouy"


def _ordered_merge_target_candidates(word: str) -> list[str]:
    candidates: list[str] = []
    is_ied_form = word.endswith("ied") and len(word) > 4
    is_ies_form = word.endswith("ies") and len(word) > 4

    if is_ied_form:
        _append_unique(candidates, word[:-3] + "y")
    if is_ies_form:
        _append_unique(candidates, word[:-3] + "y")

    if word.endswith("ing") and len(word) > 5:
        stem = word[:-3]
        if _looks_like_double_consonant(stem):
            _append_unique(candidates, stem[:-1])
        if _should_ing_add_e(stem):
            _append_unique(candidates, stem + "e")
        _append_unique(candidates, stem)

    if word.endswith("ed") and len(word) > 4 and not is_ied_form:
        stem = word[:-2]
        if stem.endswith("at") and len(stem) > 4 and stem[-3] not in "aeiou":
            _append_unique(candidates, stem + "e")
        if stem.endswith("dg") or stem.endswith("v"):
            _append_unique(candidates, stem + "e")
        if len(word) >= 3 and word[-3] == "e":
            _append_unique(candidates, word[:-1])
        if _looks_like_double_consonant(stem):
            _append_unique(candidates, stem[:-1])
        _append_unique(candidates, stem)

    for item in _base_candidates(word):
        _append_unique(candidates, item)

    final: list[str] = []
    for item in candidates:
        if item == word:
            continue
        if len(item) < 3:
            continue
        if not LETTER_WORD_PATTERN.match(item):
            continue
        final.append(item)
    return final


def _dictionary_merge_target_candidates(word: str, known_lemmas: set[str] | frozenset[str]) -> list[str]:
    return [
        candidate
        for candidate in _ordered_merge_target_candidates(word)
        if candidate in known_lemmas
    ]


def _is_strong_inflection_reason(reason: str) -> bool:
    return reason in {
        "现在分词/动名词回退到动词原形",
        "过去式/过去分词回退到动词原形",
        "-ied 词形回退到 -y 原形",
        "复数 -ies 回退到单数 -y",
    }


def _rule_reason(source: str, target: str) -> str:
    if source.endswith("ied") and target == source[:-3] + "y":
        return "-ied 词形回退到 -y 原形"
    if source.endswith("ing"):
        stem = source[:-3]
        if target in {stem, stem + "e"}:
            return "现在分词/动名词回退到动词原形"
        if _looks_like_double_consonant(stem) and target == stem[:-1]:
            return "现在分词/动名词回退到动词原形"
    if source.endswith("ed"):
        stem = source[:-2]
        if target in {stem, stem + "e"}:
            return "过去式/过去分词回退到动词原形"
        if len(source) >= 3 and source[-3] == "e" and target == source[:-1]:
            return "过去式/过去分词回退到动词原形"
        if _looks_like_double_consonant(stem) and target == stem[:-1]:
            return "过去式/过去分词回退到动词原形"
    if source.endswith("ies") and target == source[:-3] + "y":
        return "复数 -ies 回退到单数 -y"
    if source.endswith("s") and target == source[:-1]:
        return "第三人称/复数回退到原形"
    return "通用词形回退"


def _candidate_shape_bonus(source_token: str, target_token: str) -> float:
    if source_token.endswith("ied") and target_token == source_token[:-3] + "y":
        return 0.04
    if source_token.endswith("ies") and target_token == source_token[:-3] + "y":
        return 0.04
    if source_token.endswith("ing"):
        stem = source_token[:-3]
        if _looks_like_double_consonant(stem) and target_token == stem[:-1]:
            return 0.04
        if _should_ing_add_e(stem) and target_token == stem + "e":
            return 0.03
    if source_token.endswith("ed"):
        stem = source_token[:-2]
        if _looks_like_double_consonant(stem) and target_token == stem[:-1]:
            return 0.04
        if target_token == stem + "e":
            return 0.03
        if len(source_token) >= 3 and source_token[-3] == "e" and target_token == source_token[:-1]:
            return 0.03
    return 0.0


def _candidate_rule_score(source: VocabEntry, target_token: str, target: VocabEntry | None = None) -> float:
    source_defs = len(source.definitions)
    source_reviews = len(source.reviews)
    source_token = source.token or ""
    reason = _rule_reason(source_token, target_token)
    target_exists = target is not None

    if target is not None:
        similarity = _max_example_similarity(source.examples, target.examples)
        target_defs = len(target.definitions)
        target_reviews = len(target.reviews)

        if similarity < 0.45 and source_defs > 0 and target_defs > 0:
            return 0.0

        confidence = 0.58
        if similarity >= 0.85:
            confidence += 0.25
        elif similarity >= 0.7:
            confidence += 0.15
        elif similarity >= 0.5:
            confidence += 0.08

        if source_defs == 0 or target_defs == 0:
            confidence += 0.06
        if source_reviews == 0 or target_reviews == 0:
            confidence += 0.03
    else:
        if not _is_strong_inflection_reason(reason):
            return 0.0

        confidence = 0.72
        if reason in {"-ied 词形回退到 -y 原形", "复数 -ies 回退到单数 -y"}:
            confidence += 0.13
        elif reason == "过去式/过去分词回退到动词原形":
            if len(source_token) >= 3 and source_token[-3] == "e":
                confidence += 0.08
            elif source_token.endswith("ed") and _looks_like_double_consonant(source_token[:-2]):
                confidence += 0.06
        elif reason == "现在分词/动名词回退到动词原形":
            stem = source_token[:-3] if source_token.endswith("ing") else ""
            if stem and _looks_like_double_consonant(stem):
                confidence += 0.08
            if stem and _should_ing_add_e(stem) and target_token == stem + "e":
                confidence += 0.06

        if source_defs == 0:
            confidence += 0.03
        if source_reviews == 0:
            confidence += 0.02

    if reason != "通用词形回退":
        confidence += 0.08 if target_exists else 0.0
    confidence += _candidate_shape_bonus(source_token, target_token)

    return min(0.98 if target_exists else 0.97, confidence)


def _max_example_similarity(examples_a: list[dict], examples_b: list[dict]) -> float:
    texts_a = [_normalize_text_for_similarity(ex.get("text", "")) for ex in examples_a if isinstance(ex, dict)]
    texts_b = [_normalize_text_for_similarity(ex.get("text", "")) for ex in examples_b if isinstance(ex, dict)]
    texts_a = [t for t in texts_a if t]
    texts_b = [t for t in texts_b if t]
    if not texts_a or not texts_b:
        return 0.0

    best = 0.0
    for a in texts_a:
        for b in texts_b:
            best = max(best, SequenceMatcher(None, a, b).ratio())
            if best >= 0.98:
                return best
    return best


def _alpha_tokens(text: str) -> set[str]:
    return {
        token
        for token in NON_ALPHA_PATTERN.split(_normalize_text_for_similarity(text))
        if token
    }


def _token_jaccard_similarity(text_a: str, text_b: str) -> float:
    tokens_a = _alpha_tokens(text_a)
    tokens_b = _alpha_tokens(text_b)
    if not tokens_a or not tokens_b:
        return 0.0
    return len(tokens_a & tokens_b) / len(tokens_a | tokens_b)


def _definition_near_duplicate_score(text_a: str, text_b: str) -> tuple[bool, float, float]:
    ratio = SequenceMatcher(None, text_a, text_b).ratio()
    jaccard = _token_jaccard_similarity(text_a, text_b)
    min_token_len = min(len(_alpha_tokens(text_a)), len(_alpha_tokens(text_b)))

    if min_token_len <= 3:
        is_match = ratio >= 0.96 and jaccard >= 0.86
    else:
        is_match = ratio >= 0.93 and jaccard >= 0.74
    return is_match, ratio, jaccard


def _example_near_duplicate_score(text_a: str, text_b: str) -> tuple[bool, float, float]:
    ratio = SequenceMatcher(None, text_a, text_b).ratio()
    jaccard = _token_jaccard_similarity(text_a, text_b)
    is_match = ratio >= 0.94 and jaccard >= 0.78
    return is_match, ratio, jaccard


def _shorten_context_text(text: str, focus_tokens: list[str], max_words: int = 36) -> str:
    words = [part for part in _collapse_ws(text).split(" ") if part]
    if len(words) <= max_words:
        return _collapse_ws(text)

    focus_index = None
    for i, raw in enumerate(words):
        token = _surface_word_token(raw)
        if token and any(_is_word_variant_match(focus, token) for focus in focus_tokens):
            focus_index = i
            break

    if focus_index is None:
        focus_index = len(words) // 2

    half = max_words // 2
    start = max(0, focus_index - half)
    end = min(len(words), start + max_words)
    if end - start < max_words:
        start = max(0, end - max_words)

    clipped = " ".join(words[start:end]).strip()
    if start > 0:
        clipped = f"... {clipped}"
    if end < len(words):
        clipped = f"{clipped} ..."
    return clipped


def _confidence_level(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.65:
        return "medium"
    return "low"


def _build_entry(file_path: str, payload: dict) -> VocabEntry:
    file_name = Path(file_path).name
    fallback_word = Path(file_name).stem
    word = str(payload.get("word") or fallback_word).strip() or fallback_word
    definitions = payload.get("definitions") if isinstance(payload.get("definitions"), list) else []
    examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []
    reviews = payload.get("reviews") if isinstance(payload.get("reviews"), list) else []

    return VocabEntry(
        file_path=file_path,
        file_name=file_name,
        word=word,
        token=_clean_word_token(word),
        definitions=[str(item) for item in definitions if isinstance(item, str)],
        examples=[item for item in examples if isinstance(item, dict)],
        reviews=[item for item in reviews if isinstance(item, dict)],
    )


def analyze_folder_merge_suggestions(entries: list[tuple[str, dict]], include_low_confidence: bool = False) -> dict:
    vocab_entries = [_build_entry(path, payload) for path, payload in entries]
    token_to_entry = {
        entry.token: entry
        for entry in vocab_entries
        if entry.token
    }
    known_lemmas = get_lemma_words()

    suggestions = []

    for source in vocab_entries:
        if not source.token:
            continue

        candidates = _dictionary_merge_target_candidates(source.token, known_lemmas)
        if not candidates:
            continue

        selected_token = ""
        selected_target = None
        selected_confidence = 0.0
        for target_token in candidates:
            target = token_to_entry.get(target_token)
            if target is None or target.file_name == source.file_name:
                continue
            confidence = _candidate_rule_score(source, target_token, target)
            if confidence > selected_confidence:
                selected_token = target_token
                selected_target = target
                selected_confidence = confidence

        source_defs = len(source.definitions)
        source_reviews = len(source.reviews)
        source_examples = len(source.examples)

        if selected_target is not None and selected_token:
            target = selected_target
            target_defs = len(target.definitions)
            target_examples = len(target.examples)
            target_reviews = len(target.reviews)
            similarity = _max_example_similarity(source.examples, target.examples)

            reason = _rule_reason(source.token, selected_token)
            confidence = selected_confidence
            confidence_level = _confidence_level(confidence)
            if confidence_level == "low" and not include_low_confidence:
                continue

            suggestions.append(
                {
                    "type": "merge_inflection",
                    "source": {
                        "word": source.word,
                        "file": source.file_name,
                    },
                    "target": {
                        "word": target.word,
                        "file": target.file_name,
                        "exists": True,
                    },
                    "create_target_if_missing": False,
                    "confidence": round(confidence, 3),
                    "confidence_level": confidence_level,
                    "reason": reason,
                    "signals": {
                        "max_example_similarity": round(similarity, 3),
                        "target_exists": True,
                        "source_definitions": source_defs,
                        "target_definitions": target_defs,
                        "source_examples": source_examples,
                        "target_examples": target_examples,
                        "source_reviews": source_reviews,
                        "target_reviews": target_reviews,
                    },
                    "suggested_action": (
                        "将 source 的 definitions/examples/reviews 合并到 target，"
                        "保留 target 为主词条，再决定是否归档 source 文件。"
                    ),
                }
            )
            continue

        create_target_candidates = [
            (candidate, _candidate_rule_score(source, candidate, None))
            for candidate in candidates
            if candidate not in token_to_entry
        ]
        create_target_candidates = [
            item
            for item in create_target_candidates
            if item[1] >= CREATE_TARGET_CONFIDENCE_THRESHOLD
        ]
        if not create_target_candidates:
            continue

        proposed_token, confidence = max(
            create_target_candidates,
            key=lambda item: (item[1], -len(item[0]), item[0]),
        )
        reason = _rule_reason(source.token, proposed_token)
        confidence_level = _confidence_level(confidence)
        if confidence_level == "low" and not include_low_confidence:
            continue

        suggestions.append(
            {
                "type": "merge_inflection_create_target",
                "source": {
                    "word": source.word,
                    "file": source.file_name,
                },
                "target": {
                    "word": proposed_token,
                    "file": f"{proposed_token}.json",
                    "exists": False,
                },
                "create_target_if_missing": True,
                "confidence": round(confidence, 3),
                "confidence_level": confidence_level,
                "reason": f"{reason}（原型词条不存在，将自动新建）",
                "signals": {
                    "max_example_similarity": 0.0,
                    "target_exists": False,
                    "source_definitions": source_defs,
                    "target_definitions": 0,
                    "source_examples": source_examples,
                    "target_examples": 0,
                    "source_reviews": source_reviews,
                    "target_reviews": 0,
                },
                "suggested_action": (
                    "当前目录缺少原型词条；建议先新建 target，再把 source 的 "
                    "definitions/examples/reviews 合并过去。"
                ),
            }
        )

    suggestions.sort(
        key=lambda item: (
            {"high": 0, "medium": 1, "low": 2}.get(item["confidence_level"], 3),
            -item["confidence"],
            item["source"]["file"],
        )
    )

    return {
        "total_files": len(vocab_entries),
        "suggestions": suggestions,
    }


def analyze_file_cleaning_suggestions(file_name: str, payload: dict) -> dict:
    word = str(payload.get("word") or Path(file_name).stem)
    definitions = payload.get("definitions") if isinstance(payload.get("definitions"), list) else []
    examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []

    suggestions: list[dict] = []

    normalized_def_map: dict[str, list[int]] = {}
    if not definitions:
        suggestions.append(
            {
                "type": "definition_missing",
                "severity": "high",
                "suggested_action": "Definitions 为空，建议补充至少一条中文释义。",
            }
        )

    for idx, definition in enumerate(definitions):
        if not isinstance(definition, str):
            suggestions.append(
                {
                    "type": "definition_invalid_type",
                    "severity": "medium",
                    "index": idx,
                    "current": definition,
                    "suggested_action": "definitions 数组里只保留字符串释义。",
                }
            )
            continue

        normalized = _normalize_definition_key(definition)
        if not normalized:
            suggestions.append(
                {
                    "type": "definition_empty",
                    "severity": "medium",
                    "index": idx,
                    "current": definition,
                    "suggested_action": "删除空释义或补充有效释义。",
                }
            )
            continue
        normalized_def_map.setdefault(normalized, []).append(idx)

    for key, indices in normalized_def_map.items():
        if len(indices) <= 1:
            continue
        suggestions.append(
            {
                "type": "definition_duplicate",
                "severity": "high",
                "indices": indices,
                "key": key,
                "suggested_action": "合并重复释义，只保留一个最清晰版本。",
            }
        )

    for i in range(len(definitions)):
        if not isinstance(definitions[i], str):
            continue
        for j in range(i + 1, len(definitions)):
            if not isinstance(definitions[j], str):
                continue
            a = _normalize_text_for_similarity(definitions[i])
            b = _normalize_text_for_similarity(definitions[j])
            if not a or not b:
                continue
            if _normalize_definition_key(definitions[i]) == _normalize_definition_key(definitions[j]):
                continue

            matched, sim, token_overlap = _definition_near_duplicate_score(a, b)
            if matched:
                suggestions.append(
                    {
                        "type": "definition_near_duplicate",
                        "severity": "medium",
                        "indices": [i, j],
                        "similarity": round(sim, 3),
                        "token_overlap": round(token_overlap, 3),
                        "suggested_action": "语义高度重合，建议精简为更短更准的一条。",
                    }
                )

    normalized_example_map: dict[str, list[int]] = {}
    main_word_token = _clean_word_token(word)
    for idx, example in enumerate(examples):
        if not isinstance(example, dict):
            suggestions.append(
                {
                    "type": "example_invalid_type",
                    "severity": "medium",
                    "index": idx,
                    "current": example,
                    "suggested_action": "examples 数组里只保留对象。",
                }
            )
            continue

        raw_text = str(example.get("text", ""))
        cleaned_text = _collapse_ws(raw_text)
        normalized_text = _normalize_text_for_similarity(raw_text)

        if not normalized_text:
            suggestions.append(
                {
                    "type": "example_empty_text",
                    "severity": "high",
                    "index": idx,
                    "suggested_action": "删除空例句或补充完整上下文。",
                }
            )
        else:
            normalized_example_map.setdefault(normalized_text, []).append(idx)

        if raw_text != cleaned_text:
            suggestions.append(
                {
                    "type": "example_whitespace_cleanup",
                    "severity": "low",
                    "index": idx,
                    "current": raw_text,
                    "suggested": cleaned_text,
                    "suggested_action": "压缩多余空白和换行，保留单行上下文。",
                }
            )

        explanation = str(example.get("explanation", ""))
        cleaned_explanation = _collapse_ws(explanation)
        if normalized_text and not cleaned_explanation:
            suggestions.append(
                {
                    "type": "example_missing_explanation",
                    "severity": "high",
                    "index": idx,
                    "example_text": cleaned_text,
                    "suggested_action": "example explanation 为空，建议由 LLM 补充中文讲解。",
                }
            )
        elif cleaned_explanation and explanation != cleaned_explanation:
            suggestions.append(
                {
                    "type": "example_explanation_whitespace_cleanup",
                    "severity": "low",
                    "index": idx,
                    "current": explanation,
                    "suggested": cleaned_explanation,
                    "suggested_action": "清洗 explanation 中多余空白。",
                }
            )

        focus_positions = example.get("focusPositions", example.get("focusPosition", example.get("fp", example.get("fps"))))
        if isinstance(focus_positions, list):
            token_count = len(_tokenize_non_space(raw_text))
            invalid_positions = []
            for raw_pos in focus_positions:
                try:
                    pos = int(raw_pos)
                except (TypeError, ValueError):
                    invalid_positions.append(raw_pos)
                    continue
                if pos < 0 or pos >= token_count:
                    invalid_positions.append(pos)

            if invalid_positions:
                suggestions.append(
                    {
                        "type": "example_focus_positions_out_of_range",
                        "severity": "medium",
                        "index": idx,
                        "invalid_positions": invalid_positions,
                        "token_count": token_count,
                        "suggested_action": "修正越界 focusPositions。",
                    }
                )

        focus_words = example.get("focusWords")
        if isinstance(focus_words, list) and focus_words:
            normalized_focus = [token for token in (_clean_word_token(item) for item in focus_words) if token]
            if main_word_token and normalized_focus and not any(
                _is_word_variant_match(main_word_token, token) for token in normalized_focus
            ):
                suggestions.append(
                    {
                        "type": "example_focus_word_mismatch",
                        "severity": "low",
                        "index": idx,
                        "focus_words": focus_words,
                        "suggested_action": "focusWords 与主词条不一致，建议确认是否为词形变体。",
                    }
                )

    for normalized_text, indices in normalized_example_map.items():
        if len(indices) <= 1:
            continue
        suggestions.append(
            {
                "type": "example_duplicate",
                "severity": "high",
                "indices": indices,
                "normalized_text": normalized_text,
                "suggested_action": "重复例句建议合并为一条。",
            }
        )

    for i in range(len(examples)):
        if not isinstance(examples[i], dict):
            continue
        for j in range(i + 1, len(examples)):
            if not isinstance(examples[j], dict):
                continue
            a = _normalize_text_for_similarity(examples[i].get("text", ""))
            b = _normalize_text_for_similarity(examples[j].get("text", ""))
            if not a or not b:
                continue
            if a == b:
                continue
            matched, sim, token_overlap = _example_near_duplicate_score(a, b)
            if matched:
                suggestions.append(
                    {
                        "type": "example_near_duplicate",
                        "severity": "medium",
                        "indices": [i, j],
                        "similarity": round(sim, 3),
                        "token_overlap": round(token_overlap, 3),
                        "suggested_action": "上下文高度重合，建议保留信息更完整的一条。",
                    }
                )

    severity_rank = {"high": 0, "medium": 1, "low": 2}
    suggestions.sort(key=lambda item: severity_rank.get(item.get("severity", "low"), 3))

    return {
        "file": file_name,
        "word": word,
        "definition_count": len(definitions),
        "example_count": len(examples),
        "suggestion_count": len(suggestions),
        "suggestions": suggestions,
    }
