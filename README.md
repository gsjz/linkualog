# Linkual Log

`linkualog` is an English-learning toolkit built around three parts:

- `browser-plugin/`: a userscript-powered browser extension for collecting subtitle-based vocabulary
- `master-server/`: a FastAPI + React application for OCR, vocabulary curation, review, and task workflows
- `static-website/`: a Zensical-powered static site example generated from `data/*/*.json`

## Repository Layout

```text
linkualog/
├── browser-plugin/         # userscript and dev workspace
├── master-server/          # FastAPI backend + React frontend
├── static-website/         # static site example
├── data/                   # tracked vocabulary dataset
├── docker-compose.yml      # public deployment entry
├── docker-compose.domain.yml
└── deploy/nginx/           # reverse-proxy examples
```

## Quick Start

For local development:

```bash
cp .env.example .env
# fill in MASTER_SERVER_LLM_API_KEY

cd master-server
uv sync
uv run main.py
```

For Docker deployment from the repo root:

```bash
cp .env.example .env
docker compose up -d --build master-server
```

For reverse-proxy deployment on server-local high ports:

```bash
cp .env.domain.example .env
docker compose -f docker-compose.domain.yml up -d --build master-server
```

See [master-server/README.md](master-server/README.md) for backend/runtime details and [deploy/nginx/README.md](deploy/nginx/README.md) for a generic Nginx example.

## Version Control

Commit:

- source code
- deployment templates
- environment examples
- lockfiles
- curated dataset changes that are intended to be shared

Do not commit:

- `.env`
- `master-server/local_data/`
- generated static output such as `site/` and `docs/dictionary/`
- `browser-plugin/dev/node_modules/`, `master-server/frontend/node_modules/`
- server-private Nginx configs

Contribution guidance is documented in [CONTRIBUTING.md](CONTRIBUTING.md).
