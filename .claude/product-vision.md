# Product Vision — orchestrator

## Purpose

A local job scheduler daemon with systray integration, CLI, and a web dashboard. Runs cron, startup, and one-shot jobs on a single developer machine with no cloud dependency.

## Package structure

```
orchestrator/
  packages/
    orchestrator-cli/        daemon, CLI, scheduler, tray manager, dashboard process manager, per-job supervisor
    orch-core/               route logic + daemon proxy shared by orch-server and the app-core module
    orch-server/             Fastify HTTP server — REST API + static SPA serving (child process of the daemon)
    app-module-orchestrator/ app-core module: registerRoute adapter over orch-core + DSL pages
    dsl-lib-orch/            React domain components (JobCard, LogViewer, JobForm, etc.) + DSL registry entries
    orch-app/                Vite SPA served by orch-server
```

## Current state (as of 2026-11-07)

- Daemon: cron, startup, one-shot and manual jobs; each job runs under its own supervisor by default, so jobs survive a daemon restart or update. Progress/ETA, resource limits, restart policy, liveness and secrets exist.
- Distribution: JS package plus platform packages for win32-x64, darwin-arm64, darwin-x64, linux-x64 (Linux has no tray; Linux on ARM is not shipped).
- Dashboard: job CRUD, trigger, kill, enable/disable, log tail, run history, schedule timeline, audit, dry-run, progress/ETA, dark mode. Served by `orch-server` and also published as an app-core module.

## Intended direction

- **Dashboard**: stays additive; the daemon never depends on it. What is still excluded is in `out-of-scope.md` (duration sparklines, Gantt of past runs, overlap detection, import/export UI, sandboxed dry-run preview).
- **Real-time**: SSE only. A WebSocket transport is planned and not started.
- **Auth**: Local-only assumption (127.0.0.1) is permanent for the local tool. Multi-user/auth would require a scope change.

## Key runtime contracts

- Daemon port: base 47900 (`singleton-daemon-kit`); the live port is in `<configDir>/config.port`.
- Events: published to the queue daemon through `@wadeck-app/queue-sdk`, which owns the queue's address and token.
- orch-server base port: 47950 (increments on `EADDRINUSE`)
- Daemon ↔ orch-server: HTTP RPC via daemon SDK, never direct imports
- Idle shutdown signal: `{ "type": "idle-exit" }` written to orch-server stdout (newline-delimited JSON). The app-core module has no idle exit.
- Dashboard port file: `<configDir>/config.dashboard` (JSON: `{ port, pid, startedAt }`)
- App-core module: registered under `/api/modules/orchestrator`, enabled by the `appCore` key (`docs/daemon-config.md`).
