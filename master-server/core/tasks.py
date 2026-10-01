import json
import os
import stat
import tempfile
import uuid
from contextlib import contextmanager
from filelock import FileLock, Timeout

TASKS_FILE = os.environ.get("TASKS_FILE", "local_data/tasks_db.json")
LOCK_FILE = os.environ.get("LOCK_FILE", f"{TASKS_FILE}.lock")

tasks_dir = os.path.dirname(TASKS_FILE)
if tasks_dir:
    os.makedirs(tasks_dir, exist_ok=True)

def _load_tasks_unlocked():
    if not os.path.exists(TASKS_FILE):
        return {}
    with open(TASKS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_tasks_unlocked(tasks_dict):
    directory = os.path.dirname(os.path.abspath(TASKS_FILE))
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as f:
            temporary_path = f.name
            if os.path.exists(TASKS_FILE):
                os.fchmod(f.fileno(), stat.S_IMODE(os.stat(TASKS_FILE).st_mode))
            json.dump(tasks_dict, f, ensure_ascii=False, indent=2)
        os.replace(temporary_path, TASKS_FILE)
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)


def load_tasks():
    with FileLock(LOCK_FILE, timeout=5):
        return _load_tasks_unlocked()


def save_tasks(tasks_dict):
    with FileLock(LOCK_FILE, timeout=5):
        _save_tasks_unlocked(tasks_dict)


@contextmanager
def edit_tasks():
    """Keep each read/modify/write together, without locking during OCR calls."""
    with FileLock(LOCK_FILE, timeout=5):
        tasks = _load_tasks_unlocked()
        yield tasks
        _save_tasks_unlocked(tasks)


def task_processing_lock(task_id: str):
    lock_id = uuid.uuid5(uuid.NAMESPACE_URL, task_id).hex
    return FileLock(f"{LOCK_FILE}.{lock_id}.processing", timeout=0)


def recover_interrupted_tasks() -> int:
    """Make interrupted OCR resumable after restart, without starting paid work."""
    recovered = 0
    for task_id, previous in load_tasks().items():
        if previous.get("status") not in {"pending", "processing"} and not any(
            sub.get("status") == "processing" for sub in previous.get("sub_tasks", [])
        ):
            continue
        worker_lock = task_processing_lock(task_id)
        try:
            worker_lock.acquire()
        except Timeout:
            # Another server process may still be running this task.
            continue
        try:
            with edit_tasks() as saved:
                task = saved.get(task_id)
                if not task:
                    continue
                sub_tasks = task.get("sub_tasks", [])
                if task.get("status") not in {"pending", "processing"} and not any(
                    sub.get("status") == "processing" for sub in sub_tasks
                ):
                    continue
                for sub in sub_tasks:
                    if sub.get("status") == "processing":
                        sub["status"] = "failed"
                        sub["error"] = "服务重启中断了本页识别，请点击继续任务或重新生成"
                task["completed"] = sum(sub.get("status") == "completed" for sub in sub_tasks)
                task["status"] = "finished" if task["completed"] == len(sub_tasks) else "paused"
                recovered += 1
        finally:
            worker_lock.release()
    return recovered


def create_task(name: str, sub_tasks_paths: list, start_page: int = 1, auto_process: bool = True) -> str:
    task_id = str(uuid.uuid4())
    with edit_tasks() as tasks:
        tasks[task_id] = {
            "name": name,
            "status": "pending" if auto_process else "collected",
            "total": len(sub_tasks_paths),
            "completed": 0,
            "start_page": start_page,
            "auto_process": bool(auto_process),
            "sub_tasks": [{"path": p, "status": "pending", "result": None} for p in sub_tasks_paths]
        }
    return task_id
