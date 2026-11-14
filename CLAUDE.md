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

`orch cli update` is the only supported way to move to a new version: it installs first, then restarts
the daemon (`config.restart` sentinel + `POST /quit`), so the CLI and the daemon end on the same version. Nothing is
stopped before the install: the launcher, the tray and the supervisor run from `<configDir>/bin/` (staged copies,
`src/platform-binary.ts`), so npm never has to replace a running executable. See `.claude/kb/lessons-learned.md`.

**Restarting the daemon is routine, not a decision to ask about.** Each job runs under its own supervisor, so
`orch restart`, `orch stop` and `orch cli update` leave running jobs running and followed again afterwards
(`supervisedJobs`, docs/daemon-config.md). Run them when the work calls for it, then check `orch status` and the
daemon log. The exceptions say so themselves, before acting: `orch exec` commands and jobs on a host with no supervisor
die with the daemon, and each of those three commands names them first (run id, time running, command). Read that
warning, and only then decide to wait or to go ahead.

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
`@wadeck-app/orchestrator-cli-{win32-x64,darwin-arm64,linux-x64}`,
pulled in as `optionalDependencies` with an **exact** version pin, so `npm install -g` updates
them in the same transaction and a rollback restores the matching pair. They are republished
only when the binary hash changes, so their version has gaps and legitimately lags the main
package.

Linux packages carry the launcher and the supervisor but no tray (there is no Linux systray build: the daemon
says so in its log and the dashboard is reached with `orch server start`). Start at login on Linux is a systemd
user unit (`~/.config/systemd/user/orchestrator.service`, `orch install` / `orch uninstall`; see
`docs/daemon-config.md`); start at boot on Ubuntu x64 was validated by the user on a real host (2026-10-31,
`orch install` then reboot); other distributions are covered by tests only. Linux on ARM (linux-arm64) is not shipped (never run on a real host or in CI) and Intel Macs (darwin-x64) are not supported; a platform with no package says so in `orch start` and the daemon log. Validated by the user on real
hosts (stated 2026-11-13): Linux, macOS (Apple Silicon) and Windows 10 and 11, all with the CLI, the daemon and start at login.
Only the Linux boot test carries a recorded date and procedure above. The platforms are listed
once, in `PLATFORM_TARGETS` (`src/platform-binary.ts`); `test/platform-targets.test.js` fails until the ci scripts,
`optionalDependencies` and `scripts/build-supervisor-binary.ts` agree with it.

Never assume a fixed path between the two packages: npm hoists the platform package next to the
main one or nests it underneath, and both happen. `src/platform-binary.ts` resolves the launcher,
the tray and the daemon entry via `require.resolve`; the Go launcher resolves its own bundle from
the package specifier in `ci/launcher.config.json`. That is what makes start-at-login work.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | Daemon stability rules, spec-first discipline, TDD, binary test requirement + session lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover (what is still excluded from the dashboard, auth, remote access, daemon control) |
| `.claude/product-vision.md` | Purpose, package structure, current state, runtime contracts (ports, idle signal) |
| `.claude/threat-model.md` | STRIDE analysis (T-01->T-05: path traversal, accepted localhost/CSRF risks, progress regex safety, command-running endpoints) + stale port, duplicate instance risks |
| `docs/supervised-jobs.md` | How supervised jobs work: run folder contract, adoption at daemon start, runs that ended while the daemon was down |
| `docs/daemon-config.md` | `config.yml` keys (autoUpdate, supervisedJobs, catch-up, retention, log rotation, ...), job settings, progress/ETA, start at login |
| `.claude/plans/` | Open plans only: a finished plan is deleted, and nothing in the code or the docs may refer to a plan. `2026-10-25_open-points-plan.md` is the list of open points |

## Knowledge base

`.claude/kb/lessons-learned.md` is the single lessons file for this project - read it before
debugging, and add entries with the `kb` skill (`/kb`).

`.claude/lessons-learned.md` and `.claude/lessons-recommendations.md` are gitignored scratch written by
the session-end hook: a lesson only counts once it is in the kb file.
