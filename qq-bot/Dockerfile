FROM python:3.13-slim

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG APT_MIRROR_BASE=https://mirrors.tuna.tsinghua.edu.cn

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV UV_LINK_MODE=copy
ENV PIP_INDEX_URL="${PIP_INDEX_URL}"
ENV QQ_RUN_SECONDS=0
ENV QQ_LINKUALOG_BASE_URL="http://master-server:8080"
ENV QQ_LINKUALOG_DATA_DIR="/app/data"
ENV QQ_LOCAL_DATA_DIR="/app/qq-bot/local_data"
ENV QQ_SESSION_STATE_FILE="/app/qq-bot/local_data/session_state.json"

WORKDIR /app/qq-bot

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

COPY . /app/qq-bot

ENV PATH="/app/qq-bot/.venv/bin:${PATH}"

CMD ["uv", "run", "--no-sync", "main.py"]
