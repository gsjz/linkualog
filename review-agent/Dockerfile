FROM python:3.13-slim

RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY . /app/review-agent

ENV AGENT_CONFIG="/app/review-agent/user/agent_config.json"
ENV VOCAB_DIR="/app/data/"

WORKDIR /app/review-agent/dev
RUN uv sync

EXPOSE 8090 8091

CMD ["uv", "run", "main.py"]
