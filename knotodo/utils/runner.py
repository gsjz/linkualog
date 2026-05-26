import os
import subprocess
from pathlib import Path


def start_frontend_dev(frontend_port: int, backend_port: int) -> None:
    frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
    env = os.environ.copy()
    env["VITE_BACKEND_PORT"] = str(backend_port)
    subprocess.run(
        ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", str(frontend_port)],
        cwd=frontend_dir,
        env=env,
        check=True,
    )
