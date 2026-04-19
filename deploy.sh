#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  echo "docker daemon is unavailable for the current user" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "created .env from template; fill QQ_APP_ID and QQ_APP_SECRET first" >&2
fi

qq_app_id="$(sed -n 's/^QQ_APP_ID=//p' .env | head -n 1)"
qq_app_secret="$(sed -n 's/^QQ_APP_SECRET=//p' .env | head -n 1)"

if [[ -z "${qq_app_id}" ]]; then
  echo "QQ_APP_ID is missing in .env" >&2
  exit 1
fi

if [[ -z "${qq_app_secret}" || "${qq_app_secret}" == "replace_me" ]]; then
  echo "QQ_APP_SECRET is missing in .env" >&2
  exit 1
fi

"${DOCKER[@]}" rm -f master-server-app qq-linkualog-bot >/dev/null 2>&1 || true
"${DOCKER[@]}" compose --profile qq-bot up -d --build
"${DOCKER[@]}" compose --profile qq-bot ps
