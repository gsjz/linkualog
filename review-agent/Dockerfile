FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY . /app/review-agent

ENV AGENT_CONFIG="/app/review-agent/user/agent_config.json"
ENV VOCAB_DIR="/app/data/"

WORKDIR /app/review-agent/dev
RUN uv sync

CMD ["uv", "run", "main.py"]