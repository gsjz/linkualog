from __future__ import annotations

import hashlib
import json
import re
from typing import Any


WS_PATTERN = re.compile(r"\s+")
SAFE_WORD_CHARS_PATTERN = re.compile(r"[^a-z0-9-]+")
REVIEW_NOISE_MARKER_PATTERN = re.compile(r"(?:\[[0-9]{1,3}\]|https?://\S+|www\.\S+|example\.com)", re.IGNORECASE)
REVIEW_SPEAKER_PREFIX_PATTERN = re.compile(r"^(?:(?:m|w|q|a|man|woman|男|女|主持人|记者|旁白)\s*[:：]\s*)+", re.IGNORECASE)

REVIEW_MODE_ALIASES = {
    "1": 1,
    "normal": 1,
    "classic": 1,
    "explain": 1,
    "解释": 1,
    "释义": 1,
    "标准": 1,
    "2": 2,
    "cloze": 2,
    "fill": 2,
    "blank": 2,
    "填空": 2,
    "场景": 2,
    "场景填空": 2,
    "3": 3,
    "creative": 3,
    "sentence": 3,
    "写句子": 3,
    "造句": 3,
    "创意": 3,
}
REVIEW_MODE_LABELS = {
    1: "释义理解",
    2: "场景填空",
    3: "创意输出",
}
REVIEW_MODE_DESCRIPTIONS = {
    1: "看例句，用中文解释词义和用法。",
    2: "根据场景和提示回想英文词或短语，题面不会直接泄露答案。",
    3: "先看参考例句，再在新场景里写 1 句英文，必须用上目标词。",
}
EXPLICIT_REVIEW_HINT_KEYS = (
    "memory_hints",
    "memoryHints",
    "memory_hint",
    "memoryHint",
    "word_parts",
    "wordParts",
    "word_part_hint",
    "wordPartHint",
    "etymology_hint",
    "etymologyHint",
    "origin_hint",
    "originHint",
    "history_hint",
    "historyHint",
)
PHRASAL_PARTICLE_HINTS = {
    "up": "往上、启动、准备起来",
    "down": "往下压、减弱、压低",
    "out": "向外、显露出来、做到底",
    "off": "脱开、摆脱、停掉",
    "over": "翻过去、重新过一遍、额外覆盖",
    "in": "进入、卷进去、收进去",
    "on": "接上、继续推进",
    "back": "回头、回到原处、收回来",
    "away": "离开、持续消耗、一直做下去",
}
IRREGULAR_DERIVATION_HINTS = {
    "gigantic": "giant",
}
GENERIC_MEMORY_HINT_PATTERNS = (
    re.compile(r"^前缀 `[^`]+` 常", re.IGNORECASE),
    re.compile(r"^后缀 `[^`]+` 常", re.IGNORECASE),
    re.compile(r"^看到 `[^`]+`，先想到", re.IGNORECASE),
    re.compile(r"^例句里如果提到历史脉络", re.IGNORECASE),
    re.compile(r"^这是固定搭配", re.IGNORECASE),
)
CREATIVE_REVIEW_TEMPLATES = (
    {
        "id": "urgent_decision",
        "title": "创意输出 · 临场决定",
        "scene": "深夜准备离开时，情况突然变化，你得立刻做决定。",
        "task": "请写 1 句英文：深夜准备离开时，情况突然变化，你得立刻做决定，把 {word} 自然放进这句话里。",
        "tips": [
            "让句子像人在那个瞬间真的会说出、想到或做出的反应。",
            "最好带出动作、压力来源或必须表态的感觉。",
            "别写成词典释义，直接把词放进现场里。",
        ],
    },
    {
        "id": "message_reply",
        "title": "创意输出 · 消息回复",
        "scene": "朋友突然发来一条让你意外的消息，你只回一句。",
        "task": "请写 1 句英文：朋友突然发来一条让你意外的消息，你只回一句，把 {word} 自然放进回复里。",
        "tips": [
            "写出明显的回复口吻，不要像旁白。",
            "尽量让读者看得出这条消息为什么让你意外。",
            "用一个自然的人类反应，而不是机械套词。",
        ],
    },
    {
        "id": "meeting_conflict",
        "title": "创意输出 · 现场表态",
        "scene": "讨论快结束时出现分歧，有人当场表态。",
        "task": "请写 1 句英文：讨论快结束时突然出现分歧，让某个人当场表态，并自然用上 {word}。",
        "tips": [
            "句子里最好能看出立场、分歧或转折。",
            "让这句话像会议现场会冒出来的一句真实发言。",
            "别只写事实陈述，尽量写出态度。",
        ],
    },
    {
        "id": "instant_judgment",
        "title": "创意输出 · 瞬间判断",
        "scene": "你看到一个细节后，立刻改变了判断或感受。",
        "task": "请写 1 句英文：你看到一个细节后，立刻改变了判断或感受，把 {word} 自然放进去。",
        "tips": [
            "让句子里出现触发判断变化的那个细节。",
            "最好能看出前后态度的变化，而不只是描述结果。",
            "把词放在真正有判断意味的位置上。",
        ],
    },
    {
        "id": "plan_setback",
        "title": "创意输出 · 计划受阻",
        "scene": "原计划进行到一半，突然冒出一个麻烦。",
        "task": "请写 1 句英文：原计划进行到一半，突然冒出一个麻烦，把 {word} 自然放进这个受阻瞬间。",
        "tips": [
            "尽量让读者看见原计划和突发麻烦的对比。",
            "写出卡住、转向或补救的感觉。",
            "不要只报事实，尽量让句子有一点张力。",
        ],
    },
    {
        "id": "food_description",
        "title": "创意输出 · 感官描写",
        "scene": "你刚咬下一口食物，立刻注意到它的口感。",
        "task": "请写 1 句英文：你刚咬下一口食物，立刻注意到它的口感，把 {word} 自然放进描述里。",
        "tips": [
            "让句子里出现食物本体，不要只写抽象评价。",
            "尽量写出入口后的第一感受，像真实试吃反应。",
            "如果是形容词，把它放在最自然的修饰位置上。",
        ],
    },
    {
        "id": "quick_recommendation",
        "title": "创意输出 · 随口推荐",
        "scene": "朋友犹豫要不要试某样东西，你随口给出一句推荐。",
        "task": "请写 1 句英文：朋友犹豫要不要试某样东西，你随口给出一句推荐，并自然用上 {word}。",
        "tips": [
            "写出明显的口语推荐感，不要像说明书。",
            "让读者看得出你推荐的理由是什么。",
            "尽量让这句话像现实里会脱口而出的表达。",
        ],
    },
)


def _collapse_ws(text: str) -> str:
    return WS_PATTERN.sub(" ", str(text or "")).strip()


def _shorten_text(text: str, limit: int = 96) -> str:
    collapsed = _collapse_ws(text)
    if len(collapsed) <= limit:
        return collapsed
    if limit <= 3:
        return collapsed[:limit]
    return collapsed[: limit - 3] + "..."


def _split_keywords(text: str) -> list[str]:
    return [token for token in re.findall(r"[A-Za-z][A-Za-z'-]+|[\u4e00-\u9fff]{1,8}", str(text or "")) if token]


def _normalize_keyword(token: str) -> str:
    raw = _collapse_ws(token).lower()
    if not raw:
        return ""
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", raw)


def _markdown_quote(text: str, fallback: str = "暂无") -> str:
    body = _collapse_ws(text) or fallback
    return "\n".join(f"> {line}" for line in body.splitlines()) if "\n" in body else f"> {body}"


def _contains_any_keyword(text: str, keywords: set[str]) -> bool:
    raw_text = _collapse_ws(text).lower()
    tokens = {_normalize_keyword(token) for token in _split_keywords(raw_text)}
    tokens.discard("")
    return any(keyword and _normalize_keyword(keyword) in tokens for keyword in keywords)


def _append_unique_text(items: list[str], text: str, *, limit: int = 4) -> None:
    clean = _collapse_ws(text)
    if not clean:
        return
    lowered = clean.lower()
    if any(existing.lower() == lowered for existing in items):
        return
    if len(items) < limit:
        items.append(clean)


def _looks_generic_memory_hint(text: str) -> bool:
    clean = _collapse_ws(text)
    if not clean:
        return True
    return any(pattern.search(clean) for pattern in GENERIC_MEMORY_HINT_PATTERNS)


def _append_meaningful_memory_hint(items: list[str], text: str, *, limit: int = 4) -> None:
    if _looks_generic_memory_hint(text):
        return
    _append_unique_text(items, text, limit=limit)


def _collect_word_evidence_tokens(current: dict) -> list[str]:
    tokens: list[str] = []
    focus_words = current.get("focus_words") if isinstance(current.get("focus_words"), list) else []
    for item in focus_words:
        text = _collapse_ws(str(item))
        if text:
            tokens.append(text)
    for field in ("word", "word_key", "example_text"):
        raw = str(current.get(field) or "")
        tokens.extend(re.findall(r"[A-Za-z][A-Za-z'-]{2,}", raw))
    return tokens


def _select_related_memory_word(current: dict) -> str:
    word_key = normalize_answer_key(str(current.get("word_key") or current.get("word") or ""))
    if not word_key:
        return ""

    candidates: list[str] = []
    irregular_base = IRREGULAR_DERIVATION_HINTS.get(word_key)
    if irregular_base:
        candidates.append(irregular_base)

    lemma_candidates: list[str] = []
    if word_key.endswith("gantic") and len(word_key) > 7:
        lemma_candidates.append(f"{word_key[:-6]}iant")
    if word_key.endswith("ic") and len(word_key) > 5:
        lemma_candidates.append(word_key[:-2])
    if word_key.endswith("ical") and len(word_key) > 7:
        lemma_candidates.append(f"{word_key[:-4]}y")
    if word_key.endswith("ity") and len(word_key) > 6:
        lemma_candidates.append(f"{word_key[:-3]}e")
        lemma_candidates.append(word_key[:-3])
    if word_key.endswith("ness") and len(word_key) > 6:
        lemma_candidates.append(word_key[:-4])
    if word_key.endswith("less") and len(word_key) > 6:
        lemma_candidates.append(word_key[:-4])
    if word_key.endswith("ful") and len(word_key) > 5:
        lemma_candidates.append(word_key[:-3])

    for item in lemma_candidates:
        clean = normalize_answer_key(item)
        if clean and clean != word_key:
            candidates.append(clean)

    evidence = {
        normalize_answer_key(token)
        for token in _collect_word_evidence_tokens(current)
        if normalize_answer_key(token)
    }
    direct_bases = inflection_base_candidates(word_key)
    for candidate in direct_bases:
        if candidate and candidate != word_key:
            candidates.append(candidate)
    for token in evidence:
        if token == word_key:
            continue
        token_bases = inflection_base_candidates(token)
        if word_key in token_bases:
            candidates.append(token)
            continue
        if token.startswith(word_key) and 0 < len(token) - len(word_key) <= 3:
            candidates.append(token)
            continue
        if word_key.startswith(token) and 0 < len(word_key) - len(token) <= 4:
            candidates.append(token)

    seen: set[str] = set()
    for candidate in candidates:
        clean_candidate = normalize_answer_key(candidate)
        if not clean_candidate or clean_candidate == word_key or clean_candidate in seen:
            continue
        seen.add(clean_candidate)
        return clean_candidate
    return ""


def build_related_memory_hint(current: dict) -> str:
    word_key = normalize_answer_key(str(current.get("word_key") or current.get("word") or ""))
    related = _select_related_memory_word(current)
    if not word_key or not related:
        return ""
    if related in inflection_base_candidates(word_key):
        return f"先收拢到原型 `{related}` 去记，这个词条现在更像它的屈折变化。"
    if word_key in inflection_base_candidates(related):
        return f"可以和 `{related}` 放在一起记：例句里出现的是它的变体，先把两者对上。"
    return f"可以顺手连到相关词 `{related}`：先把这两个词的关系记住，再回到当前语境里的具体含义。"


def generate_llm_memory_hint(current: dict, *, llm_client: Any) -> str:
    if not getattr(llm_client, "enabled", False):
        return ""

    system_prompt = (
        "你是英语词汇记忆提示助手。"
        "请只返回 JSON，字段必须包含: hint。"
        "要求: 给 1 条中文记忆提示，优先找有价值的词根、原型、同源/相关词；"
        "不要给泛泛的基础前缀后缀知识，不要说“前缀/后缀常表示……”，不要空话；"
        "提示要紧扣当前词条、例句和释义，长度控制在 18 到 48 个中文字符左右；"
        "如果想不到高价值提示，就返回空字符串。"
    )
    user_prompt = json.dumps(
        {
            "word": current.get("word", ""),
            "word_key": current.get("word_key", ""),
            "definitions": current.get("definitions", []),
            "example_text": current.get("example_text", ""),
            "example_explanation": current.get("example_explanation", ""),
            "focus_words": current.get("focus_words", []),
        },
        ensure_ascii=False,
    )
    try:
        result = llm_client.chat_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=180,
            temperature=0.2,
            timeout=60.0,
        )
    except Exception:
        return ""

    return _collapse_ws(str(result.get("hint") or ""))


def parse_review_mode(value: object, default: int | None = None) -> int | None:
    raw = _collapse_ws(str(value or "")).lower()
    if not raw:
        return default
    if raw in REVIEW_MODE_ALIASES:
        return REVIEW_MODE_ALIASES[raw]
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return default
    if parsed in REVIEW_MODE_LABELS:
        return parsed
    return default


def review_mode_label(mode: object) -> str:
    parsed = parse_review_mode(mode, 1) or 1
    return REVIEW_MODE_LABELS.get(parsed, REVIEW_MODE_LABELS[1])


def review_mode_description(mode: object) -> str:
    parsed = parse_review_mode(mode, 1) or 1
    return REVIEW_MODE_DESCRIPTIONS.get(parsed, REVIEW_MODE_DESCRIPTIONS[1])


def normalize_answer_key(text: str) -> str:
    raw = _collapse_ws(text).lower()
    if not raw:
        return ""
    raw = raw.replace("’", "'").replace("`", "'")
    return SAFE_WORD_CHARS_PATTERN.sub("-", raw).strip("-")


def normalize_review_surface_text(text: str) -> str:
    raw = _collapse_ws(text).lower()
    if not raw:
        return ""
    raw = raw.replace("’", "'").replace("`", "'")
    return re.sub(r"[^a-z0-9]+", " ", raw).strip()


def review_target_surface_forms(current: dict) -> list[str]:
    forms: list[str] = []
    raw_candidates = [
        str(current.get("word") or "").strip(),
        str(current.get("word_key") or "").strip(),
        str(current.get("word_key") or "").replace("-", " ").strip(),
    ]
    for item in sorted(raw_candidates, key=len, reverse=True):
        normalized = normalize_review_surface_text(item)
        if normalized and normalized not in forms:
            forms.append(normalized)
    return forms


def text_contains_review_target(current: dict, text: str) -> bool:
    normalized_text = normalize_review_surface_text(text)
    if not normalized_text:
        return False
    padded = f" {normalized_text} "
    return any(f" {item} " in padded for item in review_target_surface_forms(current))


def contains_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in str(text or ""))


def looks_mostly_english(text: str) -> bool:
    raw = _collapse_ws(text)
    if len(raw) < 8:
        return False
    ascii_letters = sum(1 for char in raw if char.isascii() and char.isalpha())
    cjk_chars = sum(1 for char in raw if "\u4e00" <= char <= "\u9fff")
    return ascii_letters >= 12 and ascii_letters >= max(4, cjk_chars * 2)


def strip_review_noise(text: str) -> str:
    cleaned = _collapse_ws(text)
    if not cleaned:
        return ""
    cleaned = REVIEW_SPEAKER_PREFIX_PATTERN.sub("", cleaned)
    cleaned = REVIEW_NOISE_MARKER_PATTERN.sub(" ", cleaned)
    return _collapse_ws(cleaned)


def _append_unique_word(items: list[str], token: str, source_word: str) -> None:
    candidate = normalize_answer_key(token)
    if not candidate or candidate == source_word or candidate in items:
        return
    items.append(candidate)


def _looks_like_double_consonant(token: str) -> bool:
    return len(token) >= 2 and token[-1] == token[-2] and token[-1] not in "aeiou"


def _looks_like_cvc_stem(token: str) -> bool:
    return (
        len(token) == 3
        and token[0] not in "aeiou"
        and token[1] in "aeiou"
        and token[2] not in "aeiouywx"
    )


def _should_restore_trailing_e(stem: str) -> bool:
    if not stem:
        return False
    if _looks_like_cvc_stem(stem):
        return True
    if stem.endswith(("v", "dg", "iz")):
        return True
    if stem.endswith(("id", "od", "ud")) and len(stem) > 3 and stem[-3] not in "aeiou":
        return True
    if (
        len(stem) >= 4
        and stem[-1] in {"k", "c"}
        and stem[-2] in "aeiou"
        and not stem.endswith(("ck", "sk", "sh", "ch", "ng", "nk", "rk", "lk"))
    ):
        return True
    return False


def inflection_base_candidates(token: str) -> list[str]:
    word = normalize_answer_key(token)
    if len(word) < 4:
        return []

    candidates: list[str] = []
    is_ied_form = word.endswith("ied") and len(word) > 4
    is_ies_form = word.endswith("ies") and len(word) > 4

    if is_ied_form:
        _append_unique_word(candidates, f"{word[:-3]}y", word)
    if is_ies_form:
        _append_unique_word(candidates, f"{word[:-3]}y", word)

    if word.endswith("ing") and len(word) > 5:
        stem = word[:-3]
        if _looks_like_double_consonant(stem):
            _append_unique_word(candidates, stem[:-1], word)
        if _should_restore_trailing_e(stem):
            _append_unique_word(candidates, stem + "e", word)
        _append_unique_word(candidates, stem, word)

    if word.endswith("ed") and len(word) > 4 and not is_ied_form:
        stem = word[:-2]
        if _looks_like_double_consonant(stem):
            _append_unique_word(candidates, stem[:-1], word)
        if _should_restore_trailing_e(stem):
            _append_unique_word(candidates, stem + "e", word)
        _append_unique_word(candidates, stem, word)

    handled_es = False
    if word.endswith("es") and len(word) > 4 and not is_ies_form:
        handled_es = True
        if word.endswith(("ses", "xes", "zes", "ches", "shes", "oes")):
            _append_unique_word(candidates, word[:-2], word)
        else:
            _append_unique_word(candidates, word[:-1], word)

    if word.endswith("s") and len(word) > 3 and not word.endswith("ss") and not handled_es and not is_ies_form:
        _append_unique_word(candidates, word[:-1], word)

    return candidates


def simple_english_lemma(token: str) -> str:
    word = normalize_answer_key(token)
    if len(word) < 4:
        return word
    candidates = inflection_base_candidates(word)
    return candidates[0] if candidates else word


def cleanup_word_candidates(current: dict, example_text: str, explanation: str) -> list[str]:
    original = normalize_answer_key(str(current.get("word") or current.get("word_key") or ""))
    if len(original) < 3:
        return []

    candidates: list[str] = []
    direct_candidates = inflection_base_candidates(original)
    if len(direct_candidates) == 1:
        _append_unique_word(candidates, direct_candidates[0], original)

    focus_words = current.get("focus_words") if isinstance(current.get("focus_words"), list) else []
    evidence_tokens = [str(item) for item in focus_words if str(item).strip()]
    evidence_tokens.extend(re.findall(r"[A-Za-z][A-Za-z'-]{2,}", str(example_text or "")))
    if looks_mostly_english(explanation):
        evidence_tokens.extend(re.findall(r"[A-Za-z][A-Za-z'-]{2,}", str(explanation or "")))

    for raw_token in evidence_tokens:
        normalized = normalize_answer_key(raw_token)
        if not normalized or normalized == original:
            continue

        related: list[str] = []
        for candidate in inflection_base_candidates(normalized):
            if candidate == original:
                continue
            if candidate.startswith(original) and 0 < len(candidate) - len(original) <= 2:
                _append_unique_word(related, candidate, original)
            elif original.startswith(candidate) and 0 < len(original) - len(candidate) <= 4:
                _append_unique_word(related, candidate, original)

        if len(related) == 1:
            _append_unique_word(candidates, related[0], original)

    return candidates


def guess_cleanup_word_candidate(current: dict, example_text: str, explanation: str) -> str:
    candidates = cleanup_word_candidates(current, example_text, explanation)
    return candidates[0] if len(candidates) == 1 else ""


def infer_review_semantic_tags(current: dict) -> set[str]:
    corpus = " ".join(
        [
            str(current.get("word") or ""),
            str(current.get("word_key") or ""),
            str(current.get("example_text") or ""),
            str(current.get("example_explanation") or ""),
            " ".join(str(item) for item in current.get("definitions", []) if str(item).strip()),
        ]
    )
    lowered = corpus.lower()
    tags: set[str] = set()

    food_keywords = {
        "cookie", "cookies", "candy", "candies", "cake", "cakes", "waffle", "ice", "cream", "chocolate",
        "snack", "food", "dessert", "饼干", "糖果", "蛋糕", "华夫", "冰淇淋", "口感", "食物", "甜",
    }
    texture_keywords = {
        "crunchy", "gooey", "velvety", "crispy", "chewy", "soft", "texture", "mouth", "watering",
        "酥脆", "软糯", "丝绒", "顺滑", "口感", "香", "脆", "滑",
    }
    speech_keywords = {"say", "said", "reply", "replied", "ask", "asked", "message", "text", "发来", "回复", "消息"}
    conflict_keywords = {"meeting", "discussion", "argue", "argument", "disagree", "conflict", "讨论", "分歧", "争论", "会议"}

    if _contains_any_keyword(lowered, food_keywords):
        tags.add("food")
    if _contains_any_keyword(lowered, texture_keywords):
        tags.add("texture")
    if _contains_any_keyword(lowered, speech_keywords):
        tags.add("speech")
    if _contains_any_keyword(lowered, conflict_keywords):
        tags.add("conflict")

    definitions = current.get("definitions")
    if isinstance(definitions, list):
        for item in definitions:
            text = _collapse_ws(str(item))
            if text.startswith("adj.") or text.startswith("adj "):
                tags.add("adjective")
            if text.startswith("vt.") or text.startswith("vi.") or text.startswith("v.") or text.startswith("verb"):
                tags.add("verb")
            if text.startswith("n.") or text.startswith("noun"):
                tags.add("noun")

    return tags


def pick_review_reference_hint(current: dict, limit: int = 72) -> str:
    definitions = current.get("definitions")
    if isinstance(definitions, list):
        for item in definitions:
            text = _collapse_ws(str(item))
            if not text:
                continue
            compact = re.sub(r"^(adj|adv|n|v|vt|vi|prep|phr)\.\s*", "", text, flags=re.IGNORECASE).strip()
            if compact and not text_contains_review_target(current, compact):
                return _shorten_text(compact, min(limit, 24))

    explanation = _collapse_ws(str(current.get("example_explanation") or ""))
    if explanation:
        chunks = re.split(r"[。；;！!?？,，]", explanation)
        for chunk in chunks:
            compact = _collapse_ws(chunk)
            if compact and not text_contains_review_target(current, compact):
                return _shorten_text(compact, min(limit, 28))
    return ""


def looks_generic_creative_task(text: str) -> bool:
    normalized = _collapse_ws(text)
    if len(normalized) < 18:
        return True
    generic_patterns = (
        r"^请?用.+?写一句英文[。.!！]?$",
        r"^请?写一句包含.+?的英文[。.!！]?$",
        r"^请?用.+?造句[。.!！]?$",
        r"^请?围绕.+?创意输出[。.!！]?$",
        r"^请?写一句英文句子[。.!！]?$",
    )
    return any(re.match(pattern, normalized) for pattern in generic_patterns)


def looks_generic_creative_tip(text: str) -> bool:
    normalized = _collapse_ws(text)
    if len(normalized) < 4:
        return True
    return normalized in {
        "自然一点",
        "尽量自然",
        "语境尽量具体",
        "尽量具体",
        "用完整句子",
        "完整句子",
        "发挥创意",
        "注意语法",
        "保持简洁",
    }


def select_creative_review_template(current: dict) -> dict:
    tags = infer_review_semantic_tags(current)
    if "food" in tags or "texture" in tags:
        return next(item for item in CREATIVE_REVIEW_TEMPLATES if item["id"] == "food_description")
    if "speech" in tags and "conflict" not in tags:
        return next(item for item in CREATIVE_REVIEW_TEMPLATES if item["id"] == "quick_recommendation")

    raw = "|".join(
        [
            _collapse_ws(str(current.get("word_key") or "")),
            _collapse_ws(str(current.get("word") or "")),
            _collapse_ws(str(current.get("example_text") or "")),
            _collapse_ws(str(current.get("example_explanation") or "")),
        ]
    )
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()
    index = int(digest[:8], 16) % len(CREATIVE_REVIEW_TEMPLATES)
    return CREATIVE_REVIEW_TEMPLATES[index]


def infer_review_memory_hints(current: dict, limit: int = 3, *, llm_client: Any | None = None) -> list[str]:
    hints: list[str] = []

    for key in EXPLICIT_REVIEW_HINT_KEYS:
        raw = current.get(key)
        if isinstance(raw, str):
            _append_meaningful_memory_hint(hints, raw, limit=limit)
        elif isinstance(raw, list):
            for item in raw:
                _append_meaningful_memory_hint(hints, str(item), limit=limit)
                if len(hints) >= limit:
                    return hints[:limit]
        if len(hints) >= limit:
            return hints[:limit]

    word = _collapse_ws(str(current.get("word") or current.get("word_key") or "")).lower()
    word_key = normalize_answer_key(str(current.get("word_key") or current.get("word") or ""))
    definitions = current.get("definitions") if isinstance(current.get("definitions"), list) else []
    definitions_text = " ".join(_collapse_ws(str(item)) for item in definitions if _collapse_ws(str(item)))
    explanation = _collapse_ws(str(current.get("example_explanation") or ""))
    combined_text = f"{definitions_text} {explanation}".lower()

    if " " in word:
        parts = [part for part in re.split(r"[\s-]+", word) if part]
        if len(parts) == 2 and parts[1] in PHRASAL_PARTICLE_HINTS:
            particle_hint = PHRASAL_PARTICLE_HINTS[parts[1]]
            _append_meaningful_memory_hint(
                hints,
                f"把它拆开记：`{parts[0]}` 是核心动作，`{parts[1]}` 常带“{particle_hint}”的语感。",
                limit=limit,
            )
    related_hint = build_related_memory_hint(current)
    if related_hint:
        _append_meaningful_memory_hint(hints, related_hint, limit=limit)

    cached_llm_hints = current.get("_generated_memory_hints")
    if isinstance(cached_llm_hints, list):
        for item in cached_llm_hints:
            _append_meaningful_memory_hint(hints, str(item), limit=limit)
            if len(hints) >= limit:
                return hints[:limit]

    if len(hints) < limit and llm_client is not None:
        llm_hint = generate_llm_memory_hint(current, llm_client=llm_client)
        if llm_hint:
            generated = current.get("_generated_memory_hints")
            if not isinstance(generated, list):
                generated = []
                current["_generated_memory_hints"] = generated
            if llm_hint not in generated:
                generated.append(llm_hint)
            _append_meaningful_memory_hint(hints, llm_hint, limit=limit)

    return hints[:limit]


def _blank_target_in_text(current: dict, text: str) -> str:
    raw_text = str(text or "").strip()
    if not raw_text:
        return ""
    raw_candidates = [
        str(current.get("word") or "").strip(),
        str(current.get("word_key") or "").replace("-", " ").strip(),
        str(current.get("word_key") or "").strip(),
    ]
    seen: set[str] = set()
    for candidate in sorted(raw_candidates, key=len, reverse=True):
        normalized = normalize_review_surface_text(candidate)
        if not candidate or not normalized or normalized in seen:
            continue
        seen.add(normalized)
        parts = [re.escape(part) for part in re.split(r"[\s-]+", candidate) if part]
        if not parts:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9]){'[-\\s]+'.join(parts)}(?![A-Za-z0-9])", flags=re.IGNORECASE)
        replaced, count = pattern.subn("_____", raw_text, count=1)
        if count:
            return replaced
    return ""


def build_fill_blank_challenge(current: dict, *, llm_client: Any) -> dict:
    accepted_answers = []
    for item in [current.get("word"), current.get("word_key"), str(current.get("word_key") or "").replace("-", " ")]:
        text = _collapse_ws(str(item or ""))
        if text and text not in accepted_answers:
            accepted_answers.append(text)

    hint_source = ""
    for item in current.get("definitions", []):
        if contains_cjk(item):
            hint_source = item
            break
    if not hint_source:
        hint_source = current.get("example_explanation") or ""

    target_length = max(len(str(current.get("word") or current.get("word_key") or "").replace(" ", "").replace("-", "")), 1)
    safe_hint = _shorten_text(hint_source or "", 64)
    if not safe_hint or text_contains_review_target(current, safe_hint):
        safe_hint = f"长度约 {target_length} 个字符"

    fallback_prompt = _blank_target_in_text(current, str(current.get("example_text") or ""))
    if fallback_prompt and text_contains_review_target(current, fallback_prompt):
        fallback_prompt = ""
    fallback = {
        "mode": 2,
        "title": "场景填空",
        "scene": "请根据下面的具体场景和语境，回想目标英文词或短语。",
        "prompt": fallback_prompt or f"请填空：_____。中文提示：{safe_hint}",
        "answer_hint": safe_hint,
        "accepted_answers": accepted_answers,
    }

    if not getattr(llm_client, "enabled", False):
        return fallback

    system_prompt = (
        "你是词汇复习出题器，负责生成模式2场景填空题。"
        "请只返回 JSON，字段必须包含: title, scene, prompt, answer_hint, accepted_answers。"
        "要求: scene、prompt、answer_hint 这三个给用户看的字段里，都不能出现目标词本身，"
        "也不能出现只是把连字符改成空格的变体；prompt 里必须且只应出现一个 `_____` 空格；"
        "不能直接照抄原例句超过一半；场景要具体、简洁、有一点画面感；"
        "answer_hint 只能给中文语义、词性、长度或语用线索，不能泄露答案；"
        "accepted_answers 必须包含目标词规范写法。"
    )
    user_prompt = json.dumps(
        {
            "word": current.get("word", ""),
            "word_key": current.get("word_key", ""),
            "definitions": current.get("definitions", []),
            "example_text": current.get("example_text", ""),
            "example_explanation": current.get("example_explanation", ""),
        },
        ensure_ascii=False,
    )
    try:
        result = llm_client.chat_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=420,
            temperature=0.8,
            timeout=90.0,
        )
    except Exception:
        return fallback

    scene = _collapse_ws(str(result.get("scene") or "")) or fallback["scene"]
    if text_contains_review_target(current, scene):
        scene = fallback["scene"]

    prompt = _collapse_ws(str(result.get("prompt") or "")) or fallback["prompt"]
    if prompt.count("_____") != 1 or text_contains_review_target(current, prompt):
        prompt = fallback["prompt"]

    answer_hint = _collapse_ws(str(result.get("answer_hint") or "")) or fallback["answer_hint"]
    if text_contains_review_target(current, answer_hint):
        answer_hint = fallback["answer_hint"]

    accepted = []
    raw_accepted = result.get("accepted_answers") if isinstance(result.get("accepted_answers"), list) else []
    for item in raw_accepted + accepted_answers:
        text = _collapse_ws(str(item or ""))
        if text and text not in accepted:
            accepted.append(text)

    return {
        "mode": 2,
        "title": _collapse_ws(str(result.get("title") or "")) or fallback["title"],
        "scene": scene,
        "prompt": prompt,
        "answer_hint": answer_hint,
        "accepted_answers": accepted or accepted_answers,
    }


def build_creative_challenge(current: dict, *, llm_client: Any) -> dict:
    word = _collapse_ws(str(current.get("word") or current.get("word_key") or "这个词"))
    reference_hint = pick_review_reference_hint(current, 56)
    template = select_creative_review_template(current)
    base_task = _collapse_ws(str(template.get("task") or "").format(word=word))
    if reference_hint:
        base_task += f" 语义尽量贴近：{reference_hint}。"
    base_task += " 不要照抄参考例句。"
    fallback = {
        "mode": 3,
        "template_id": str(template.get("id") or "creative"),
        "title": _collapse_ws(str(template.get("title") or "")) or "创意输出",
        "task": base_task,
        "tips": [_collapse_ws(str(item)) for item in template.get("tips", []) if _collapse_ws(str(item))][:3]
        or [
            "只写 1 句英文，并且实际用上目标词。",
            "不要直接改写参考例句，换一个新场景。",
            "尽量写出人物、动作、情绪或冲突，让意思更清楚。",
        ],
        "scene_anchor": _collapse_ws(str(template.get("scene") or "")),
    }

    if not getattr(llm_client, "enabled", False):
        return fallback

    system_prompt = (
        "你是词汇复习出题器，负责在固定模板内润色模式3创意输出题。"
        "请只返回 JSON，字段必须包含: title, task, tips。"
        "要求: 只能在给定模板和微场景里润色，不能换题型，不能改成泛泛的“用这个词造句”；"
        "task 必须明确要求用户只写 1 句英文、实际用上目标词、不要照抄参考例句；"
        "微场景必须保留具体性；tips 必须给 2-3 条具体可执行的中文提示，避免空话。"
    )
    user_prompt = json.dumps(
        {
            "word": current.get("word", ""),
            "definitions": current.get("definitions", []),
            "example_text": current.get("example_text", ""),
            "example_explanation": current.get("example_explanation", ""),
            "selected_template": {
                "id": fallback["template_id"],
                "title": fallback["title"],
                "scene_anchor": fallback.get("scene_anchor", ""),
                "base_task": fallback["task"],
                "base_tips": fallback["tips"],
            },
        },
        ensure_ascii=False,
    )
    try:
        result = llm_client.chat_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=360,
            temperature=0.85,
            timeout=90.0,
        )
    except Exception:
        return fallback

    task = _collapse_ws(str(result.get("task") or "")) or fallback["task"]
    if looks_generic_creative_task(task) or not text_contains_review_target(current, task):
        task = fallback["task"]

    tips = result.get("tips") if isinstance(result.get("tips"), list) else []
    cleaned_tips = [
        _collapse_ws(str(item))
        for item in tips
        if _collapse_ws(str(item)) and not looks_generic_creative_tip(str(item))
    ]
    if len(cleaned_tips) < 2:
        cleaned_tips = fallback["tips"]

    return {
        **fallback,
        "title": _collapse_ws(str(result.get("title") or "")) or fallback["title"],
        "task": task,
        "tips": cleaned_tips[:3],
    }


def ensure_review_challenge(current: dict, mode: int, *, llm_client: Any) -> dict:
    challenge = current.get("challenge")
    if isinstance(challenge, dict) and int(challenge.get("mode", 0) or 0) == mode:
        return challenge

    if mode == 2:
        challenge = build_fill_blank_challenge(current, llm_client=llm_client)
    elif mode == 3:
        challenge = build_creative_challenge(current, llm_client=llm_client)
    else:
        challenge = {"mode": 1, "title": "释义理解"}

    current["challenge"] = challenge
    return challenge


def format_mode_switcher(mode: int, *, mode_command: str) -> list[str]:
    lines = ["**切换模式**"]
    for option in (1, 2, 3):
        command = f"`{mode_command} {option}`"
        label = f"模式 {option} · {review_mode_label(option)}"
        if option == mode:
            lines.append(f"- {command} **{label}（当前）**")
        else:
            lines.append(f"- {command} {label}")
    return lines


def format_review_prompt(
    current: dict,
    *,
    intro: bool,
    mode: int,
    challenge: dict,
    llm_client: Any | None = None,
    note: str = "",
    mode_command: str,
    skip_command: str,
    end_command: str,
) -> str:
    title_prefix = "已进入" if intro else "下一题"
    reason = str(current.get("reason") or "").strip()
    memory_hints = infer_review_memory_hints(current, llm_client=llm_client)
    lines = [f"### {title_prefix} Review · 模式 {mode} {review_mode_label(mode)}", ""]
    if note:
        lines.extend([f"_{note}_", ""])

    lines.extend(
        [
            f"- 目录: `{current.get('category', '')}`",
            f"- 说明: {review_mode_description(mode)}",
            "",
            *format_mode_switcher(mode, mode_command=mode_command),
            "",
            f"- 操作: `{skip_command}` 跳过 · `{end_command}` 退出",
        ]
    )
    if reason:
        lines.append(f"- 推荐原因: {reason}")

    if mode == 1:
        lines.extend(
            [
                f"- 词条: **{current.get('word', '')}**",
                "",
                "**例句**",
                _markdown_quote(str(current.get("example_text") or ""), fallback="暂无例句"),
                "",
                "**你的任务**",
                "请用中文解释这个词在例句里的意思和用法。",
                "",
                "**输出格式**",
                "- 直接用中文回答，尽量点出词义和句中作用。",
            ]
        )
        if memory_hints:
            lines.extend(["", "**构词联想**"])
            for item in memory_hints:
                lines.append(f"- {item}")
        return "\n".join(lines)

    if mode == 2:
        answer_length = len(str(current.get("word") or current.get("word_key") or "").replace(" ", "").replace("-", ""))
        lines.extend(
            [
                f"- 长度提示: `{max(answer_length, 1)}`",
                f"- 提示: {challenge.get('answer_hint', '请根据语境回想')}",
                "",
                f"**{challenge.get('title', '场景填空')}**",
                _markdown_quote(str(challenge.get("scene") or ""), fallback="请根据场景作答。"),
                "",
                "**你要填什么**",
                _markdown_quote(str(challenge.get("prompt") or ""), fallback="请直接填写英文单词或短语。"),
                "",
                "**输出格式**",
                "- 只回复英文单词或短语，不要解释。",
            ]
        )
        return "\n".join(lines)

    reference_hint = pick_review_reference_hint(current, 72)
    lines.append(f"- 词条: **{current.get('word', '')}**")
    if reference_hint:
        lines.append(f"- 参考语义: {reference_hint}")
    lines.extend(
        [
            "",
            "**参考例句**",
            _markdown_quote(str(current.get("example_text") or ""), fallback="暂无参考例句"),
            "",
            "**你的任务**",
            _markdown_quote(str(challenge.get("task") or ""), fallback="请写一句英文。"),
            "",
            "**不要这样做**",
            "- 不要照抄参考例句。",
            "- 不要只回单词、中文或解释。",
            "- 不要写多句；只写 1 句英文。",
            "",
            "**输出格式**",
            "- 直接回复 1 句英文，不要额外解释。",
        ]
    )
    tips = challenge.get("tips") if isinstance(challenge.get("tips"), list) else []
    if tips:
        lines.extend(["", "**额外提示**"])
        for item in tips[:3]:
            lines.append(f"- {item}")
    if memory_hints:
        lines.extend(["", "**构词联想**"])
        for item in memory_hints:
            lines.append(f"- {item}")
    return "\n".join(lines)
