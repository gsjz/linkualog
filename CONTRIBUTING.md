# Contributing

## Scope

Keep one commit focused on one type of change. Do not mix these in the same commit unless they are inseparable:

- feature work
- bug fixes
- refactors
- deployment/config changes
- docs updates
- dataset refreshes

## Commit Message

Recommended format:

```text
type(scope): summary
```

Useful types:

- `feat`
- `fix`
- `refactor`
- `build`
- `docs`
- `chore`
- `data`

Examples:

- `feat(review): add desktop minimal mode`
- `fix(server): restore vocabulary merge suggestions`
- `build(deploy): add reverse-proxy deployment template`
- `docs(readme): rewrite public setup guide`
- `chore(repo): ignore private nginx configs`
- `data(cet): refresh curated entries`

## Open-Source Hygiene

Do commit:

- generic deployment examples
- `.env.example` and `.env.domain.example`
- public docs and setup guides

Do not commit:

- `.env`
- `master-server/local_data/`
- generated static website output
- private domains, certificates, or machine-specific Nginx configs

## Suggested Split For Release Prep

1. `chore(repo): ignore private deployment files`
2. `build(deploy): add generic reverse-proxy deployment templates`
3. `docs(project): rewrite public setup and contribution docs`
4. `data(...): refresh tracked vocabulary data`
