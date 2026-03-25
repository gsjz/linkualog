import os
import json
import re
from datetime import datetime
from filelock import FileLock

VOCAB_DIR = os.environ.get("VOCAB_DIR")
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
        if context:
            existing_examples = existing_data.setdefault("examples", [])
            matched_ex = next((ex for ex in existing_examples if ex.get("text") == context), None)
            
            if matched_ex:
                if extracted_explanation:
                    matched_ex["explanation"] = extracted_explanation
                if focus_words != [word] and focus_words:
                    matched_ex["focusWords"] = focus_words
                if source_name and not matched_ex.get("source", {}).get("text"):
                    matched_ex["source"] = {"text": source_name, "url": matched_ex.get("source", {}).get("url", "")}
            else:
                existing_examples.append({
                    "text": context,
                    "explanation": extracted_explanation,
                    "focusWords": focus_words,
                    "source": {
                        "text": source_name if source_name else "",
                        "url": ""
                    }
                })
        
        if llm_generated_data.get("pronunciation") and not existing_data.get("pronunciation"):
            existing_data["pronunciation"] = llm_generated_data["pronunciation"]
            
        if llm_generated_data.get("definitions"):
            existing_defs = existing_data.setdefault("definitions", [])
            for d in llm_generated_data["definitions"]:
                if d not in existing_defs:
                    existing_defs.append(d)
        
        save_vocab(word, existing_data)
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

        new_data = {
            "word": word,
            "createdAt": today,
            "reviews": [],
            "pronunciation": llm_generated_data.get("pronunciation", ""),
            "definitions": llm_generated_data.get("definitions", []),
            "examples": [new_example] if new_example else []
        }
        save_vocab(word, new_data)
        return new_data