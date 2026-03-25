import os

STORAGE_DIR = os.environ.get("STORAGE_DIR")
MAX_SIZE_BYTES = int(os.environ.get("MAX_SIZE_BYTES"))

def get_dir_size(path=STORAGE_DIR):
    """计算文件夹总体积"""
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
    
    file_path = os.path.join(STORAGE_DIR, filename)
    with open(file_path, "wb") as f:
        f.write(file_bytes)
    return file_path