import glob
import json
import os
import threading
from contextlib import contextmanager
from pathlib import Path

from filelock import FileLock

from core.data_paths import ensure_vocabulary_dir, get_vocabulary_dir

DEFAULT_VOCAB_DIR = get_vocabulary_dir()
VOCAB_DIR = str(ensure_vocabulary_dir())
MAX_SCAN_FILES = int(os.environ.get("MAX_SCAN_FILES", "2000"))
_OPERATION_LOCK_STATE = threading.local()


def _vocab_root() -> str:
    root = os.path.abspath(str(VOCAB_DIR or get_vocabulary_dir()))
    os.makedirs(root, exist_ok=True)
    return root


def _assert_in_vocab_root(path: str) -> str:
    root = _vocab_root()
    abs_path = os.path.abspath(path)
    if os.path.commonpath([root, abs_path]) != root:
        raise ValueError("非法路径：超出数据目录范围")
    return abs_path


def list_categories() -> list[str]:
    root = _vocab_root()
    categories = [
        name for name in os.listdir(root)
        if os.path.isdir(os.path.join(root, name))
    ]
    categories.sort()
    return categories


def resolve_category_dir(category: str) -> str:
    category = (category or "").strip()
    if not category:
        return _vocab_root()

    category_dir = _assert_in_vocab_root(os.path.join(_vocab_root(), category))
    if not os.path.isdir(category_dir):
        raise FileNotFoundError(f"目录不存在: {category}")
    return category_dir


def list_vocab_files(category: str) -> list[str]:
    category_dir = resolve_category_dir(category)
    files = sorted(glob.glob(os.path.join(category_dir, "*.json")))
    if len(files) > MAX_SCAN_FILES:
        raise ValueError(f"目录文件数过多: {len(files)}，超过上限 {MAX_SCAN_FILES}")
    return files


def _normalize_filename(filename: str) -> str:
    name = (filename or "").strip()
    if not name:
        raise ValueError("filename 不能为空")
    if not name.endswith(".json"):
        name = f"{name}.json"
    return name


def resolve_vocab_file(category: str, filename: str) -> str:
    category_dir = resolve_category_dir(category)
    file_path = _assert_in_vocab_root(os.path.join(category_dir, _normalize_filename(filename)))
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"词条文件不存在: {filename}")
    return file_path


def resolve_vocab_file_for_write(category: str, filename: str) -> str:
    category_dir = resolve_category_dir(category)
    return _assert_in_vocab_root(os.path.join(category_dir, _normalize_filename(filename)))


def load_vocab_file(file_path: str) -> dict:
    path = _assert_in_vocab_root(file_path)
    with FileLock(f"{path}.lock", timeout=5):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)


def save_vocab_file(file_path: str, data: dict) -> None:
    path = _assert_in_vocab_root(file_path)
    with FileLock(f"{path}.lock", timeout=5):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


@contextmanager
def vocabulary_operation_lock(timeout: int = 180):
    depth = int(getattr(_OPERATION_LOCK_STATE, "depth", 0) or 0)
    if depth > 0:
        _OPERATION_LOCK_STATE.depth = depth + 1
        try:
            yield
        finally:
            _OPERATION_LOCK_STATE.depth = depth
        return

    root = _vocab_root()
    lock_path = os.path.join(root, ".vocabulary-operation.lock")
    with FileLock(lock_path, timeout=timeout):
        _OPERATION_LOCK_STATE.depth = 1
        try:
            yield
        finally:
            _OPERATION_LOCK_STATE.depth = 0


def load_vocab_entry(category: str, filename: str) -> tuple[str, dict]:
    path = resolve_vocab_file(category, filename)
    return path, load_vocab_file(path)


def list_vocab_filenames(category: str) -> list[str]:
    files = list_vocab_files(category)
    return [Path(path).name for path in files]
