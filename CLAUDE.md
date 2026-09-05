# orchestrator

Cross-platform job orchestrator daemon (`@wadeck-app/orchestrator-cli`) + optional web dashboard (`orch-server`). Schedules cron, startup, and one-shot jobs; auto-restarts on update.

## Quick reference

```sh
orch start / stop / restart / status
orch add cron <id> --schedule "0 9 * * *" --command "node script.js"
orch server start   # web dashboard
orch logs [--follow]
```

Config dir: `~/.config/orchestrator-cli/`. Port file: `<configDir>/config.port`.

## Packages

| Package | Role |
|---|---|
| `packages/orchestrator-cli` | Daemon + CLI entry point |
| `packages/orch-server` | Fastify web dashboard (child process of daemon) |
| `packages/orch-app` | React SPA served by orch-server |

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | Daemon stability rules, spec-first discipline, TDD, binary test requirement + session lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover (dashboard v2 items, auth, remote access) |
| `.claude/product-vision.md` | v1/v2 roadmap, runtime contracts (ports, idle signal) |
| `.claude/threat-model.md` | STRIDE analysis (T-01→T-03) + stale port, duplicate instance risks |

## Knowledge base

- `.claude/lessons-learned.md` - session-sourced lessons; read before debugging.
- `.claude/lessons-recommendations.md` - recommendations extracted from past sessions.
