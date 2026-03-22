import subprocess
import webbrowser
import time
import sys
import os

def start_frontend_dev(port=8888):
    """启动前端开发服务器并打开浏览器"""
    
    # 获取 frontend 目录的绝对路径
    current_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = os.path.join(current_dir, "frontend")

    if not os.path.exists(frontend_dir):
        print(f"❌ 错误: 找不到前端目录 {frontend_dir}")
        return

    print(f"🚀 正在启动 Vite 前端服务 (端口: {port})...")
    
    # Windows 环境下调用 npm 需要 shell=True
    is_windows = sys.platform.startswith('win')
    
    # 构建启动命令
    # "npm run dev -- --port 8888 --strictPort" 
    # --strictPort 确保如果端口被占用，Vite 会报错而不是自动换端口，这样我们打开的 URL 才准确
    cmd = ["npm", "run", "dev", "--", "--port", str(port), "--strictPort"]

    try:
        # 启动子进程，cwd 指定运行目录为 frontend/
        vite_process = subprocess.Popen(
            cmd,
            cwd=frontend_dir,
            shell=is_windows
        )

        # 给 Vite 留出 2 秒左右的编译和启动时间
        time.sleep(2)

        # 检查进程是否因为端口冲突等原因意外退出
        if vite_process.poll() is not None:
            print("❌ Vite 服务启动失败，请检查端口是否被占用或 frontend 依赖是否已安装。")
            return

        # 自动打开浏览器
        url = f"http://localhost:{port}"
        print(f"🌐 服务启动成功！正在打开浏览器: {url}")
        webbrowser.open(url)

        # 阻塞主线程，保持服务运行
        vite_process.wait()

    except KeyboardInterrupt:
        print("\n🛑 收到退出指令，正在关闭前端服务...")
        vite_process.terminate()
        print("👋 服务已关闭。")
    except Exception as e:
        print(f"❌ 发生未知错误: {e}")

if __name__ == "__main__":
    # 你可以在这里随意修改你想要的端口，避免撞车
    CUSTOM_PORT = 13344 
    start_frontend_dev(port=CUSTOM_PORT)