FROM python:3.13-slim

RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs gcc g++ python3-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY . /app/master-server

ENV CONFIG_FILE="/app/master-server/local_data/llm_config.json"
ENV STORAGE_DIR="/app/master-server/local_data/temp_storage"
ENV TASKS_FILE="/app/master-server/local_data/tasks_db.json"
ENV LOCK_FILE="/app/master-server/local_data/tasks_db.json.lock"
ENV VOCAB_DIR="/app/data/"

WORKDIR /app/master-server
RUN uv sync

EXPOSE 80 8080

CMD ["uv", "run", "main.py"]
