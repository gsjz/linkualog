ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG APT_MIRROR_BASE=https://mirrors.tuna.tsinghua.edu.cn

FROM node:20-bookworm-slim AS frontend-builder

ARG NPM_REGISTRY
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH="${VITE_BASE_PATH}"

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
ENV KNOTODO_SERVE_BUILT_FRONTEND=1
ENV KNOTODO_DISABLE_FRONTEND=1
ENV PIP_INDEX_URL="${PIP_INDEX_URL}"
ENV KNOTODO_DB_FILE="/app/knotodo/local_data/state.json"
ENV KNOTODO_LOCK_FILE="/app/knotodo/local_data/state.json.lock"
ENV KNOTODO_BASE_PATH=""
ENV UV_LINK_MODE=copy

WORKDIR /app/knotodo

RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR_BASE}|g" /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR_BASE}|g" /etc/apt/sources.list; \
    fi
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && python -m pip install --no-cache-dir "uv==0.7.21" \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . /app/knotodo
COPY --from=frontend-builder /app/frontend/dist /app/knotodo/frontend/dist

ENV PATH="/app/knotodo/.venv/bin:${PATH}"

EXPOSE 8081

CMD ["python", "main.py"]
