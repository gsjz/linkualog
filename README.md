# Linkual Log

`linkualog` is an English-learning toolkit built around three parts:

- `browser-plugin/`: a userscript-powered browser extension for collecting subtitle-based vocabulary
- `master-server/`: a FastAPI + React application for OCR, vocabulary curation, review, and task workflows
- `qq-bot/`: a QQ bot connector that routes chat commands into `master-server`
- `static-website/`: a Zensical-powered static site example generated from `data/*/*.json`

## Repository Layout

```text
linkualog/
├── browser-plugin/         # userscript and dev workspace
├── master-server/          # FastAPI backend + React frontend
├── qq-bot/                 # QQ bot connector
├── static-website/         # static site example
├── data/                   # tracked vocabulary dataset
├── deploy.sh               # full-stack Docker deployment entry
├── docker-compose.yml      # public deployment entry
├── docker-compose.domain.yml
└── deploy/nginx/           # reverse-proxy examples
```

## Quick Start

For local development:

```bash
cp .env.example .env
# fill in MASTER_SERVER_LLM_API_KEY when needed

cd master-server
uv sync
uv run main.py
```

If you also want the QQ bot locally:

```bash
cd /home/ubuntu/linkualog
# 确保项目根目录 .env 已填好 QQ_APP_ID / QQ_APP_SECRET
cd qq-bot
uv sync
uv run main.py
```

For full Docker deployment from the repo root:

```bash
cp .env.example .env
# fill in QQ_APP_ID and QQ_APP_SECRET

./deploy.sh
```

For backend-only Docker deployment:

```bash
cp .env.example .env
docker compose up -d --build master-server
```

For reverse-proxy deployment on server-local high ports:

```bash
cp .env.domain.example .env
docker compose -f docker-compose.domain.yml --profile qq-bot up -d --build
```

See [master-server/README.md](master-server/README.md) for backend/runtime details, [qq-bot/README.md](qq-bot/README.md) for QQ connector behavior, and [deploy/nginx/README.md](deploy/nginx/README.md) for a generic Nginx example.

## Version Control

Commit:

- source code
- deployment templates
- environment examples
- lockfiles
- curated dataset changes that are intended to be shared

Do not commit:

- `.env`
- `qq-bot/.env.local`
- `master-server/local_data/`
- `qq-bot/local_data/`
- QQ connector e2e / pre-deploy / post-deploy sample vocab in `data/`
- generated static output such as `site/` and `docs/dictionary/`
- `browser-plugin/dev/node_modules/`, `master-server/frontend/node_modules/`
- server-private Nginx configs

Contribution guidance is documented in [CONTRIBUTING.md](CONTRIBUTING.md).
