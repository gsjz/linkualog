import os
import time
import threading
import logging
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

os.environ.setdefault("CONFIG_FILE", "local_data/llm_config.json")
os.environ.setdefault("DEFAULT_PROVIDER", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
os.environ.setdefault("DEFAULT_MODEL", "qwen3.5-flash")

os.environ.setdefault("STORAGE_DIR", "local_data/temp_storage")
os.environ.setdefault("MAX_SIZE_BYTES", str(1 * 1024 * 1024 * 1024)) # 1GB 限制

os.environ.setdefault("TASKS_FILE", "local_data/tasks_db.json")
os.environ.setdefault("LOCK_FILE", "local_data/tasks_db.json.lock")

os.environ.setdefault("VOCAB_DIR", "../../data/")

from api.routes import router
from utils.runner import start_frontend_dev

class EndpointFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "GET /api/task" in msg:
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(EndpointFilter())

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

if __name__ == "__main__":
    FRONTEND_PORT = 13344
    BACKEND_PORT = 13345
    
    frontend_thread = threading.Thread(target=start_frontend_dev, args=(FRONTEND_PORT, BACKEND_PORT))
    frontend_thread.daemon = True
    frontend_thread.start()
    
    print(f"🚀 正在启动 FastAPI 后端服务 (端口: {BACKEND_PORT})...")
    uvicorn.run(app, host="0.0.0.0", port=BACKEND_PORT)