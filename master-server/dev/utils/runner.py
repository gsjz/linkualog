import subprocess
import os
import sys

def start_frontend_dev(frontend_port=8888, backend_port=8000):
    """启动前端开发服务器并暴露在局域网"""
    current_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    frontend_dir = os.path.join(current_dir, "frontend")

    if not os.path.exists(frontend_dir):
        print(f"❌ 错误: 找不到前端目录 {frontend_dir}")
        return

    print(f"🚀 正在启动 Vite 前端服务 (前端端口: {frontend_port}, 绑定后端端口: {backend_port})...")
    is_windows = sys.platform.startswith('win')
    
    custom_env = os.environ.copy()
    custom_env["VITE_BACKEND_PORT"] = str(backend_port)
    
    cmd = ["npm", "run", "dev", "--", "--host", "--port", str(frontend_port), "--strictPort"]

    try:
        subprocess.Popen(cmd, cwd=frontend_dir, shell=is_windows, env=custom_env)
    except Exception as e:
        print(f"❌ 启动前端失败: {e}")