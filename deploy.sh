#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

COMPOSE_FILE="docker-compose.yml"
PROJECT_NAME="linkualog"

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  echo "docker daemon is unavailable for the current user" >&2
  exit 1
fi

container_compose_project() {
  local container_name="$1"
  "${DOCKER[@]}" inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${container_name}" 2>/dev/null || true
}

ensure_matching_deployment_mode() {
  local container_name="$1"
  local actual_project
  actual_project="$(container_compose_project "${container_name}")"
  if [[ -z "${actual_project}" || "${actual_project}" == "${PROJECT_NAME}" ]]; then
    return 0
  fi

  echo "container ${container_name} is managed by compose project ${actual_project}" >&2
  echo "refusing to mix compose projects; use project ${PROJECT_NAME} with ${COMPOSE_FILE}" >&2
  exit 1
}

ensure_matching_deployment_mode "master-server-app"
ensure_matching_deployment_mode "knotodo-app"
ensure_matching_deployment_mode "qq-linkualog-bot"

requires_master_server_config() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local target
  for target in "$@"; do
    case "${target}" in
      master-server|qq-bot)
        return 0
        ;;
    esac
  done
  return 1
}

requires_qq_config() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local target
  for target in "$@"; do
    if [[ "${target}" == "qq-bot" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ ! -f .env ]]; then
  cp .env.example .env
  if requires_master_server_config "$@"; then
    echo "created .env from template; fill MASTER_SERVER_LLM_API_KEY first" >&2
  else
    echo "created .env from template" >&2
  fi
fi

if requires_master_server_config "$@"; then
  llm_api_key="$(sed -n 's/^MASTER_SERVER_LLM_API_KEY=//p' .env | head -n 1)"
  if [[ -z "${llm_api_key}" || "${llm_api_key}" == "replace_me" ]]; then
    echo "MASTER_SERVER_LLM_API_KEY is missing in .env" >&2
    exit 1
  fi
fi

if requires_qq_config "$@"; then
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
fi

"${DOCKER[@]}" compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" --profile qq-bot up -d --build "$@"
"${DOCKER[@]}" compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" --profile qq-bot ps
