.PHONY: help rebuild-master rebuild-knotodo rebuild-qq rebuild-all ps logs-master logs-knotodo logs-qq

COMPOSE_FILE ?= docker-compose.yml
DOCKER ?= sudo docker
DOCKER_COMPOSE := $(DOCKER) compose -f $(COMPOSE_FILE)

help:
	@printf '%s\n' 'Available targets:'
	@printf '  %-18s %s\n' 'rebuild-master' 'Rebuild and start the master-server container'
	@printf '  %-18s %s\n' 'rebuild-knotodo' 'Rebuild and start the knotodo container'
	@printf '  %-18s %s\n' 'rebuild-qq' 'Rebuild and start the qq-bot container'
	@printf '  %-18s %s\n' 'rebuild-all' 'Rebuild and start master-server, knotodo, and qq-bot'
	@printf '  %-18s %s\n' 'ps' 'Show compose service status'
	@printf '  %-18s %s\n' 'logs-master' 'Follow master-server logs'
	@printf '  %-18s %s\n' 'logs-knotodo' 'Follow knotodo logs'
	@printf '  %-18s %s\n' 'logs-qq' 'Follow qq-bot logs'
	@printf '\n%s\n' 'Defaults to docker-compose.yml, the reverse-proxy deployment file.'
	@printf '%s\n' 'Use DOCKER=docker if your user can run Docker without sudo.'

rebuild-master:
	$(DOCKER_COMPOSE) up -d --build master-server

rebuild-knotodo:
	$(DOCKER_COMPOSE) up -d --build knotodo

rebuild-qq:
	$(DOCKER_COMPOSE) --profile qq-bot up -d --build qq-bot

rebuild-all:
	$(DOCKER_COMPOSE) --profile qq-bot up -d --build

ps:
	$(DOCKER_COMPOSE) --profile qq-bot ps

logs-master:
	$(DOCKER_COMPOSE) logs -f master-server

logs-knotodo:
	$(DOCKER_COMPOSE) logs -f knotodo

logs-qq:
	$(DOCKER_COMPOSE) --profile qq-bot logs -f qq-bot
