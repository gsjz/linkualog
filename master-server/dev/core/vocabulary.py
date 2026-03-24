import os
import json
import re
from datetime import datetime
from filelock import FileLock

VOCAB_DIR = "local_data/vocabulary"
os.makedirs(VOCAB_DIR, exist_ok=True)

def get_vocab_path(word: str) -> str:
    clean_word = re.sub(r'[\s_]+', '-', word.strip().lower())
    return os.path.join(VOCAB_DIR, f"{clean_word}.json")

def load_vocab(word: str):
    path = get_vocab_path(word)
    if not os.path.exists(path):
        return None
    with FileLock(f"{path}.lock", timeout=5):
        with open(path, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return None

def save_vocab(word: str, data: dict):
    path = get_vocab_path(word)
    with FileLock(f"{path}.lock", timeout=5):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

def merge_or_create_vocab(word: str, context: str, source_name: str, llm_generated_data: dict = None) -> dict:
    if llm_generated_data is None:
        llm_generated_data = {}
        
    existing_data = load_vocab(word)
    today = datetime.now().strftime("%Y-%m-%d")
    
    new_example = {
        "text": context,
        "explanation": llm_generated_data.get("context_translation", ""),
        "focusWords": [word],
        "source": {
            "text": source_name if source_name else "",
            "url": ""
        }
    }

    if existing_data:
        existing_texts = [ex.get("text") for ex in existing_data.get("examples", [])]
        if context not in existing_texts:
            existing_data["examples"].append(new_example)
        
        if llm_generated_data.get("pronunciation") and not existing_data.get("pronunciation"):
            existing_data["pronunciation"] = llm_generated_data["pronunciation"]
            
        if llm_generated_data.get("definitions"):
            existing_defs = set(existing_data.get("definitions", []))
            for d in llm_generated_data["definitions"]:
                if d not in existing_defs:
                    existing_data.setdefault("definitions", []).append(d)
        
        save_vocab(word, existing_data)
        return existing_data
    else:
        new_data = {
            "word": word,
            "createdAt": today,
            "reviews": [],
            "pronunciation": llm_generated_data.get("pronunciation", ""),
            "definitions": llm_generated_data.get("definitions", []),
            "examples": [new_example]
        }
        save_vocab(word, new_data)
        return new_data