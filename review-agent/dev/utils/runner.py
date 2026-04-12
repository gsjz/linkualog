import os
import subprocess
import sys


def start_frontend_dev(frontend_port=8091, backend_port=8090):
    current_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    frontend_dir = os.path.join(current_dir, 'frontend')

    if not os.path.exists(frontend_dir):
        print(f'❌ 错误: 找不到前端目录 {frontend_dir}')
        return

    print(f'🚀 正在启动 Review Agent 前端 (前端端口: {frontend_port}, 绑定后端端口: {backend_port})...')
    is_windows = sys.platform.startswith('win')

    custom_env = os.environ.copy()
    custom_env['VITE_BACKEND_PORT'] = str(backend_port)

    try:
        subprocess.run(['npm', 'install'], cwd=frontend_dir, shell=is_windows, env=custom_env, check=True)
        subprocess.Popen(
            ['npm', 'run', 'dev', '--', '--host', '--port', str(frontend_port), '--strictPort'],
            cwd=frontend_dir,
            shell=is_windows,
            env=custom_env,
        )
    except Exception as exc:
        print(f'❌ 启动前端失败: {exc}')
