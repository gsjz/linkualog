# Linkual Log

Linkualog 是一个面向英语学习的个人词汇工作流：收集图片、PDF、视频字幕或聊天素材，经 OCR / LLM 辅助整理后，保存为可复习、可维护、可生成静态站的 JSON 词条。

## Architecture

![Linkualog architecture](static-website/docs/assets/architecture.svg)

## Runtime Data

Persistent runtime data is split under the repository-level `data/` mount:

```text
data/
  vocabulary/   # Linkualog word JSON files
  knotodo/      # KnoTodo state.json and backups
```

`master-server` and `qq-bot` read vocabulary from `data/vocabulary/`. `knotodo` writes its own JSON state to `data/knotodo/`, which is ignored except for `.gitkeep` so it can be managed separately later.

Domain deployments expose Linkualog at `/` and KnoTodo at `/todo`, for example `https://log.shujie.cc/todo`.

## Docs

- [Static website entry](static-website/docs/index.md)
- [Master server](master-server/README.md)
- [KnoTodo](knotodo/README.md)
- [QQ bot](qq-bot/README.md)
- [Nginx deploy](deploy/nginx/README.md)
