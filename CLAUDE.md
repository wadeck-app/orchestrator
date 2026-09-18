# orchestrator

Cross-platform job orchestrator daemon (`@wadeck-app/orchestrator-cli`) + optional web dashboard (`orch-server`). Schedules cron, startup, and one-shot jobs; auto-restarts on update.

## Quick reference

```sh
orch start [--no-follow] / stop / restart / status
orch add cron <id> --schedule "0 9 * * *" --command "node script.js"
orch trigger <id>            # fire now
orch kill <id>               # stop a running job (alias: orch terminate)
orch server start            # web dashboard
orch logs [--follow]
orch cli update              # update orch itself -- never `npm install -g` by hand
```

`orch cli update` is the only supported way to move to a new version: it stops the daemon through
the launcher before installing, so the native binary is not locked, and it leaves the CLI and the
daemon on the same version. See `.claude/kb/lessons-learned.md`.

Config dir: `~/.config/orchestrator/`. Port file: `<configDir>/config.port`.

`orch start` tails logs in an interactive TTY and returns immediately otherwise; `--no-follow`
opts out. `terminate` exists because shell guardrails often block the word `kill`.

## Packages

| Package | Role |
|---|---|
| `packages/orchestrator-cli` | Daemon + CLI entry point |
| `packages/orch-server` | Fastify web dashboard (child process of daemon) |
| `packages/orch-app` | React SPA served by orch-server |
| `packages/orch-ui` | React components consumed by orch-app |

## Distribution

The published `@wadeck-app/orchestrator-cli` ships **only** JS: `dist/orchestrator.cjs`
(daemon), `dist/orchestrator-cli.cjs` (CLI), `dist/orchestrator-updater.cjs`, plus `bin/` and
`server/`. No native binary.

The Go launcher and the tray live in `@wadeck-app/orchestrator-cli-{win32-x64,darwin-arm64,darwin-x64}`,
pulled in as `optionalDependencies` with an **exact** version pin, so `npm install -g` updates
them in the same transaction and a rollback restores the matching pair. They are republished
only when the binary hash changes, so their version has gaps and legitimately lags the main
package.

Never assume a fixed path between the two packages: npm hoists the platform package next to the
main one or nests it underneath, and both happen. `src/platform-binary.ts` resolves the launcher,
the tray and the daemon entry via `require.resolve`; the Go launcher resolves its own bundle from
the package specifier in `ci/launcher.config.json`. That is what makes start-at-login work.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | Daemon stability rules, spec-first discipline, TDD, binary test requirement + session lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover (dashboard v2 items, auth, remote access) |
| `.claude/product-vision.md` | v1/v2 roadmap, runtime contracts (ports, idle signal) |
| `.claude/threat-model.md` | STRIDE analysis (T-01→T-03) + stale port, duplicate instance risks |
| `docs/daemon-config.md` | `config.yml` keys: autoUpdate, catchUpInitialDelaySeconds, catchUpStaggerSeconds |

## Knowledge base

- `.claude/lessons-learned.md` - session-sourced lessons; read before debugging.
- `.claude/lessons-recommendations.md` - recommendations extracted from past sessions.
