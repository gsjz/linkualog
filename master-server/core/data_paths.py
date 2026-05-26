import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_ROOT = REPO_ROOT / "data"
DEFAULT_VOCABULARY_DIR = DEFAULT_DATA_ROOT / "vocabulary"


def _clean_path(value: str | os.PathLike | None) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    return Path(text).expanduser()


def get_data_root() -> Path:
    return _clean_path(os.environ.get("DATA_DIR")) or DEFAULT_DATA_ROOT


def get_vocabulary_dir() -> Path:
    explicit_vocab_dir = _clean_path(os.environ.get("VOCAB_DIR"))
    if explicit_vocab_dir is not None:
        if explicit_vocab_dir.name == "vocabulary":
            return explicit_vocab_dir
        if explicit_vocab_dir.name == "data":
            return explicit_vocab_dir / "vocabulary"
        nested_vocab_dir = explicit_vocab_dir / "vocabulary"
        if nested_vocab_dir.exists():
            return nested_vocab_dir
        return explicit_vocab_dir

    return get_data_root() / "vocabulary"


def ensure_vocabulary_dir() -> Path:
    vocab_dir = get_vocabulary_dir()
    vocab_dir.mkdir(parents=True, exist_ok=True)
    return vocab_dir
