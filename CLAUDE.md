# orchestrator

Cross-platform job orchestrator daemon (`@wadeck-app/orchestrator-cli`) + optional web dashboard (`orch-server`). Schedules cron, startup, and one-shot jobs (and holds manual jobs that run only when triggered); auto-restarts on update.

## Quick reference

```sh
orch start [--no-follow] / stop / restart / status
orch add cron <id> --schedule "0 9 * * *" --command "node script.js"
orch add startup <id> --command "..." --timeout 0 --restart-on-exit   # keep a server up after ANY exit (docs/daemon-config.md)
orch trigger <id>            # fire now
orch kill <id>               # stop a running job (alias: orch terminate)
orch restart-job <id>        # end a job's running instances, then start it again (orch restart = the daemon)
orch server start            # web dashboard
orch job <jobId> logs [execId] [-f]  # one execution's log, plain text (default latest; --list, -n, --raw; orch job --help)
orch edit <id> --log-max-size 20 --log-keep 3   # cap a run's log: segments of 20 MB, newest 3 kept (docs/daemon-config.md)
orch progress replay <jobId>  # score the progress/ETA strategies on a job's past runs (add/edit: --progress, --progress-options)
orch logs [--follow]         # daemon log
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
| `packages/orch-core` | Logic shared by both dashboard controllers: `DaemonProxy`, job/log/open routes, `RouteHost` seam. No Fastify or app-core import (guarded by a test); sources only, bundled by each consumer |
| `packages/orch-server` | Fastify controller: bootstrap, static files, CORS, port file, idle exit (child process of daemon); bundled with orch-core into `dist/index.js` by `scripts/bundle.mjs` |
| `packages/app-module-orchestrator` | app-core controller: `ctx.registerRoute` adapter + `ALLOWED_ROUTES` over orch-core; never imports orch-server |
| `packages/orch-app` | React SPA served by orch-server |
| `packages/dsl-lib-orch` | React domain components + the DSL library of the orchestrator app-core module; consumed by orch-app (`@wadeck-app/dsl-lib-orch/ui`) and `app-module-orchestrator` (`@wadeck-app/dsl-lib-orch`) |

## Distribution

The published `@wadeck-app/orchestrator-cli` ships **only** JS: `dist/orchestrator.cjs`
(daemon), `dist/orchestrator-cli.cjs` (CLI), `dist/orchestrator-updater.cjs`, plus `bin/` and
`server/`. No native binary.

The Go launcher, the supervisor and (Windows, macOS) the tray live in
`@wadeck-app/orchestrator-cli-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}`,
pulled in as `optionalDependencies` with an **exact** version pin, so `npm install -g` updates
them in the same transaction and a rollback restores the matching pair. They are republished
only when the binary hash changes, so their version has gaps and legitimately lags the main
package.

Linux packages carry the launcher and the supervisor but no tray (there is no Linux systray build: the daemon
says so in its log and the dashboard is reached with `orch server start`). Start at login is not implemented on
Linux (`orch` reports `Unsupported platform: linux`); start the daemon with `orch start`. The platforms are listed
once, in `PLATFORM_TARGETS` (`src/platform-binary.ts`); `test/platform-targets.test.js` fails until the ci scripts,
`optionalDependencies` and `scripts/build-supervisor-binary.ts` agree with it. Not yet run on a real Linux host.

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
| `.claude/threat-model.md` | STRIDE analysis (T-01->T-03) + stale port, duplicate instance risks |
| `docs/daemon-config.md` | `config.yml` keys: autoUpdate, catchUpInitialDelaySeconds, catchUpStaggerSeconds |

## Knowledge base

`.claude/kb/lessons-learned.md` is the single lessons file for this project - read it before
debugging, and add entries with the `kb` skill (`/kb`).

There used to be a second, flat `.claude/lessons-learned.md` written by the w-learning session-end
hook, plus its `.claude/lessons-recommendations.md`. Both were merged into the kb file and are now
gitignored: the hook still recreates them locally on every session end, so treat anything it writes
as scratch. A lesson only counts once it is in the kb file.
