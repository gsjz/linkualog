import json
import os
import uuid
from filelock import FileLock  

TASKS_FILE = os.environ.get("TASKS_FILE", "local_data/tasks_db.json")
LOCK_FILE = os.environ.get("LOCK_FILE", f"{TASKS_FILE}.lock")

tasks_dir = os.path.dirname(TASKS_FILE)
if tasks_dir:
    os.makedirs(tasks_dir, exist_ok=True)

def load_tasks():
    if not os.path.exists(TASKS_FILE): 
        return {}
    
    with FileLock(LOCK_FILE, timeout=5):
        with open(TASKS_FILE, "r", encoding="utf-8") as f: 
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return {}

def save_tasks(tasks_dict):
    with FileLock(LOCK_FILE, timeout=5):
        with open(TASKS_FILE, "w", encoding="utf-8") as f: 
            json.dump(tasks_dict, f, ensure_ascii=False, indent=2)

def create_task(name: str, sub_tasks_paths: list, start_page: int = 1) -> str:
    tasks = load_tasks()
    task_id = str(uuid.uuid4())
    tasks[task_id] = {
        "name": name,
        "status": "pending",
        "total": len(sub_tasks_paths),
        "completed": 0,
        "start_page": start_page, 
        "sub_tasks": [{"path": p, "status": "pending", "result": None} for p in sub_tasks_paths]
    }
    save_tasks(tasks)
    return task_id
