.PHONY: help rebuild-master rebuild-qq rebuild-all ps logs-master logs-qq

COMPOSE_FILE ?= docker-compose.domain.yml
DOCKER ?= sudo docker
DOCKER_COMPOSE := $(DOCKER) compose -f $(COMPOSE_FILE)

help:
	@printf '%s\n' 'Available targets:'
	@printf '  %-18s %s\n' 'rebuild-master' 'Rebuild and start the master-server container'
	@printf '  %-18s %s\n' 'rebuild-qq' 'Rebuild and start the qq-bot container'
	@printf '  %-18s %s\n' 'rebuild-all' 'Rebuild and start master-server and qq-bot'
	@printf '  %-18s %s\n' 'ps' 'Show compose service status'
	@printf '  %-18s %s\n' 'logs-master' 'Follow master-server logs'
	@printf '  %-18s %s\n' 'logs-qq' 'Follow qq-bot logs'
	@printf '\n%s\n' 'Defaults to docker-compose.domain.yml to avoid binding host port 80.'
	@printf '%s\n' 'Use COMPOSE_FILE=docker-compose.yml for direct host port 80/8080 publishing.'
	@printf '%s\n' 'Use DOCKER=docker if your user can run Docker without sudo.'

rebuild-master:
	$(DOCKER_COMPOSE) up -d --build master-server

rebuild-qq:
	$(DOCKER_COMPOSE) --profile qq-bot up -d --build qq-bot

rebuild-all:
	$(DOCKER_COMPOSE) --profile qq-bot up -d --build

ps:
	$(DOCKER_COMPOSE) --profile qq-bot ps

logs-master:
	$(DOCKER_COMPOSE) logs -f master-server

logs-qq:
	$(DOCKER_COMPOSE) --profile qq-bot logs -f qq-bot
