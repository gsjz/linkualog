from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger("master_server.review.lemma_dictionary")

LETTER_WORD_PATTERN = re.compile(r"^[a-z]+$")
LEMMA_DICTIONARY_PATH = Path(__file__).resolve().parent / "data" / "wordnet_lemmas.json"


def normalize_lemma_word(raw_word: str) -> str | None:
    token = str(raw_word or "").strip().lower()
    token = token.replace("’", "'").replace("`", "'")
    if not LETTER_WORD_PATTERN.match(token):
        return None
    return token


@lru_cache(maxsize=1)
def get_lemma_words() -> frozenset[str]:
    try:
        raw_items = json.loads(LEMMA_DICTIONARY_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to load lemma dictionary from %s: %s", LEMMA_DICTIONARY_PATH, exc)
        return frozenset()

    if not isinstance(raw_items, list):
        logger.warning("Lemma dictionary must be a JSON array: %s", LEMMA_DICTIONARY_PATH)
        return frozenset()

    lemmas = set()
    for item in raw_items:
        token = normalize_lemma_word(str(item or ""))
        if token:
            lemmas.add(token)
    return frozenset(lemmas)


def is_known_lemma(raw_word: str) -> bool:
    token = normalize_lemma_word(raw_word)
    if not token:
        return False
    return token in get_lemma_words()
