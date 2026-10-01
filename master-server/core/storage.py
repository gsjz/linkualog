import os
import tempfile

STORAGE_DIR = os.environ.get("STORAGE_DIR", "local_data/temp_storage")
MAX_SIZE_BYTES = int(os.environ.get("MAX_SIZE_BYTES", str(1 * 1024 * 1024 * 1024)))

def get_dir_size(path=None):
    """计算文件夹总体积"""
    path = STORAGE_DIR if path is None else path
    if not os.path.exists(path): return 0
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total

def save_temp_file(file_bytes: bytes, filename: str) -> str:
    """带限额检查的文件保存"""
    os.makedirs(STORAGE_DIR, exist_ok=True)
    if get_dir_size() + len(file_bytes) > MAX_SIZE_BYTES:
        raise Exception("服务器临时存储空间已达 1GB 上限，请先清理。")
    
    # Camera uploads and pasted images frequently share a filename. Each task
    # owns a distinct file so another upload/delete cannot alter its pages.
    safe_name = os.path.basename(str(filename or "image").replace("\\", "/"))
    suffix = os.path.splitext(safe_name)[1].lower()
    with tempfile.NamedTemporaryFile("wb", prefix="upload-", suffix=suffix, dir=STORAGE_DIR, delete=False) as f:
        f.write(file_bytes)
        return f.name
