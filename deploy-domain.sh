#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

COMPOSE_FILE="docker-compose.domain.yml"
PROJECT_NAME="linkualog"
EXPECTED_CONFIG_FILE="${SCRIPT_DIR}/${COMPOSE_FILE}"

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  echo "docker daemon is unavailable for the current user" >&2
  exit 1
fi

container_compose_file() {
  local container_name="$1"
  "${DOCKER[@]}" inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "${container_name}" 2>/dev/null || true
}

ensure_matching_deployment_mode() {
  local container_name="$1"
  local actual_config_file
  actual_config_file="$(container_compose_file "${container_name}")"
  if [[ -z "${actual_config_file}" || "${actual_config_file}" == "${EXPECTED_CONFIG_FILE}" ]]; then
    return 0
  fi

  echo "container ${container_name} is managed by ${actual_config_file}" >&2
  echo "refusing to mix deployment modes; use ./deploy.sh for direct public-port deployment" >&2
  exit 1
}

ensure_matching_deployment_mode "master-server-app"
ensure_matching_deployment_mode "qq-linkualog-bot"

if [[ ! -f .env ]]; then
  cp .env.domain.example .env
  echo "created .env from domain template; fill MASTER_SERVER_LLM_API_KEY first" >&2
fi

llm_api_key="$(sed -n 's/^MASTER_SERVER_LLM_API_KEY=//p' .env | head -n 1)"
if [[ -z "${llm_api_key}" || "${llm_api_key}" == "replace_me" ]]; then
  echo "MASTER_SERVER_LLM_API_KEY is missing in .env" >&2
  exit 1
fi

"${DOCKER[@]}" compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" --profile qq-bot up -d --build "$@"
"${DOCKER[@]}" compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" --profile qq-bot ps
