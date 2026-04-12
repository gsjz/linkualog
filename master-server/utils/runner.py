import os
import subprocess
import sys
from pathlib import Path


def _start_frontend_dir(dirname: str, label: str, frontend_port: int, backend_port: int) -> None:
    app_dir = Path(__file__).resolve().parent.parent
    frontend_dir = app_dir / dirname

    if not frontend_dir.exists():
        print(f"❌ 错误: 找不到前端目录 {frontend_dir}")
        return

    print(f"🚀 正在启动 {label} 前端服务 (前端端口: {frontend_port}, 绑定后端端口: {backend_port})...")
    is_windows = sys.platform.startswith('win')

    custom_env = os.environ.copy()
    custom_env["VITE_BACKEND_PORT"] = str(backend_port)

    try:
        subprocess.run(["npm", "install"], cwd=frontend_dir, shell=is_windows, env=custom_env, check=True)
        cmd = ["npm", "run", "dev", "--", "--host", "--port", str(frontend_port), "--strictPort"]
        subprocess.Popen(cmd, cwd=frontend_dir, shell=is_windows, env=custom_env)
    except Exception as e:
        print(f"❌ 启动前端失败: {e}")


def start_frontend_dev(frontend_port=80, backend_port=8080):
    _start_frontend_dir("frontend", "Master Server", frontend_port, backend_port)
