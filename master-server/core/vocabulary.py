import glob
import json
import os
import re
from datetime import datetime

from filelock import FileLock

VOCAB_DIR = os.environ.get("VOCAB_DIR", "../data/")
os.makedirs(VOCAB_DIR, exist_ok=True)


def normalize_vocab_lookup_word(word: str) -> str:
    return re.sub(r"\.json$", "", str(word or "").strip(), flags=re.IGNORECASE)


def _sanitize_category(category: str) -> str:
    normalized = str(category or "").strip()
    if not normalized:
        return ""

    safe_category = re.sub(r'[^\w\u4e00-\u9fa5\.-]+', '_', normalized)
    if safe_category in {".", ".."} or safe_category.startswith("."):
        raise ValueError("目录名非法")
    return safe_category


def require_vocab_subdir(category: str) -> str:
    safe_category = _sanitize_category(category)
    if not safe_category:
        raise ValueError("保存目录不能为空，必须使用 data/文件夹/")
    return safe_category


def get_vocab_path(word: str, category: str = "", require_subdir: bool = False, create_dir: bool = True) -> str:
    normalized_word = normalize_vocab_lookup_word(word)
    clean_word = re.sub(r'[\s_]+', '-', normalized_word.lower())
    safe_category = require_vocab_subdir(category) if require_subdir else _sanitize_category(category)
    base_dir = os.path.join(VOCAB_DIR, safe_category) if safe_category else VOCAB_DIR
    if create_dir:
        os.makedirs(base_dir, exist_ok=True)
    return os.path.join(base_dir, f"{clean_word}.json")


def list_vocab_filenames(category: str = "") -> list[str]:
    safe_category = _sanitize_category(category)
    target_dir = os.path.join(VOCAB_DIR, safe_category) if safe_category else VOCAB_DIR
    if not os.path.isdir(target_dir):
        return []
    return sorted(os.path.basename(path) for path in glob.glob(os.path.join(target_dir, "*.json")))


def list_vocab_words(category: str = "") -> list[str]:
    return [os.path.splitext(filename)[0] for filename in list_vocab_filenames(category)]

def load_vocab(word: str, category: str = ""):
    path = get_vocab_path(word, category, create_dir=False)
    if not os.path.exists(path):
        return None
    with FileLock(f"{path}.lock", timeout=5):
        with open(path, "r", encoding="utf-8") as f:
            try:
                data = json.load(f)
                if isinstance(data, dict):
                    data.pop("pronunciation", None)
                return data
            except json.JSONDecodeError:
                return None

def save_vocab(word: str, data: dict, category: str = ""):
    path = get_vocab_path(word, category, require_subdir=True)
    with FileLock(f"{path}.lock", timeout=5):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

def _sanitize_focus_positions(raw_focus) -> list[int]:
    if not isinstance(raw_focus, list):
        return []
    values = []
    seen = set()
    for item in raw_focus:
        try:
            idx = int(item)
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx in seen:
            continue
        seen.add(idx)
        values.append(idx)
    values.sort()
    return values


def merge_or_create_vocab(
    word: str,
    context: str,
    source_name: str,
    llm_generated_data: dict = None,
    category: str = "",
    focus_positions: list[int] = None,
    youtube: dict = None
) -> dict:
    if llm_generated_data is None:
        llm_generated_data = {}
    category = require_vocab_subdir(category)
    sanitized_focus_positions = _sanitize_focus_positions(focus_positions if focus_positions is not None else [])
        
    existing_data = load_vocab(word, category)
    today = datetime.now().strftime("%Y-%m-%d")
    
    extracted_explanation = ""
    focus_words = [word]
    
    if "examples" in llm_generated_data and isinstance(llm_generated_data["examples"], list):
        for llm_ex in llm_generated_data["examples"]:
            if not context or llm_ex.get("text") == context:
                extracted_explanation = llm_ex.get("explanation", "")
                if "focusWords" in llm_ex:
                    focus_words = llm_ex.get("focusWords", [word])
                break
                
    if not extracted_explanation:
        extracted_explanation = llm_generated_data.get("explanation", llm_generated_data.get("context_translation", ""))

    if existing_data:
        existing_data.pop("pronunciation", None)
        if context:
            existing_examples = existing_data.setdefault("examples", [])
            matched_ex = next((ex for ex in existing_examples if ex.get("text") == context), None)
            
            if matched_ex:
                if extracted_explanation:
                    matched_ex["explanation"] = extracted_explanation
                if focus_words != [word] and focus_words:
                    matched_ex["focusWords"] = focus_words
                if sanitized_focus_positions:
                    matched_ex["focusPositions"] = sanitized_focus_positions
                if source_name and not matched_ex.get("source", {}).get("text"):
                    matched_ex["source"] = {"text": source_name, "url": matched_ex.get("source", {}).get("url", "")}
                
                if youtube and not matched_ex.get("youtube"):
                    matched_ex["youtube"] = youtube
            else:
                new_ex = {
                    "text": context,
                    "explanation": extracted_explanation,
                    "focusWords": focus_words,
                    "source": {
                        "text": source_name if source_name else "",
                        "url": ""
                    }
                }
                if sanitized_focus_positions:
                    new_ex["focusPositions"] = sanitized_focus_positions
                if youtube:
                    new_ex["youtube"] = youtube
                existing_examples.append(new_ex)
        
        if llm_generated_data.get("definitions"):
            existing_defs = existing_data.setdefault("definitions", [])
            for d in llm_generated_data["definitions"]:
                if d not in existing_defs:
                    existing_defs.append(d)
        
        save_vocab(word, existing_data, category)
        return existing_data
        
    else:
        new_example = {
            "text": context,
            "explanation": extracted_explanation,
            "focusWords": focus_words,
            "source": {
                "text": source_name if source_name else "",
                "url": ""
            }
        } if context else None
        if new_example and sanitized_focus_positions:
            new_example["focusPositions"] = sanitized_focus_positions
        
        if new_example and youtube:
            new_example["youtube"] = youtube

        new_data = {
            "word": word,
            "createdAt": today,
            "reviews": [],
            "definitions": llm_generated_data.get("definitions", []),
            "examples": [new_example] if new_example else []
        }
        save_vocab(word, new_data, category)
        return new_data
