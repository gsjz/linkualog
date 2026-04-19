ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG APT_MIRROR_BASE=https://mirrors.tuna.tsinghua.edu.cn

FROM node:20-bookworm-slim AS frontend-builder

ARG NPM_REGISTRY

WORKDIR /app/frontend

RUN npm config set registry "${NPM_REGISTRY}"

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim

ARG PIP_INDEX_URL
ARG APT_MIRROR_BASE

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV CONFIG_FILE="/app/master-server/local_data/llm_config.json"
ENV STORAGE_DIR="/app/master-server/local_data/temp_storage"
ENV TASKS_FILE="/app/master-server/local_data/tasks_db.json"
ENV LOCK_FILE="/app/master-server/local_data/tasks_db.json.lock"
ENV VOCAB_DIR="/app/data/"
ENV MASTER_SERVER_SERVE_BUILT_FRONTEND=1
ENV MASTER_SERVER_DISABLE_FRONTEND=1
ENV UV_LINK_MODE=copy
ENV PIP_INDEX_URL="${PIP_INDEX_URL}"

WORKDIR /app/master-server

RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR_BASE}|g" /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR_BASE}|g" /etc/apt/sources.list; \
    fi
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && python -m pip install --no-cache-dir "uv==0.7.21" \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . /app/master-server
COPY --from=frontend-builder /app/frontend/dist /app/master-server/frontend/dist

ENV PATH="/app/master-server/.venv/bin:${PATH}"

EXPOSE 8080

CMD ["uv", "run", "--no-sync", "main.py"]
