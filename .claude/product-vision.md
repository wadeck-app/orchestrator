# Product Vision — orchestrator

## Purpose

A local job scheduler daemon with systray integration, CLI, and a web dashboard. Runs cron, startup, and one-shot jobs on a single developer machine with no cloud dependency.

## Package structure

```
orchestrator/
  packages/
    orchestrator-cli/    daemon, CLI, scheduler, tray manager, dashboard process manager
    orch-server/         Fastify HTTP server — REST API + static SPA serving
    orch-ui/             React domain components (JobCard, LogViewer, JobForm, etc.)
    orch-app/            Vite SPA (pages, routes, heartbeat)
```

## Current state (as of 2026-08-31)

- `orchestrator-cli` is the established package: daemon, cron scheduler, tray, self-check, CLI commands.
- Web dashboard is in progress per plan at `.claude/plans/2026-08-31_orch-web-dashboard.md`. `orch-server` has `idle-timer.ts`, `port.ts`, `daemon-proxy.ts` implemented; routes are partially implemented. `orch-app` has `useHeartbeat` and `registry.ts`.

## Intended direction

- **v1 dashboard**: Full CRUD for jobs, trigger, enable/disable, live log tail, run history (last 20 entries) — covering all day-to-day terminal actions.
- **v2 dashboard**: Duration sparklines, Gantt view, overlap detection, import/export, dry-run preview, advanced job fields (`liveness`, `onExitCode`, `missedFiring`).
- **Daemon**: Continues to own job execution; dashboard is additive, never a dependency.
- **Auth**: Local-only assumption (127.0.0.1) is permanent for the local tool. Multi-user/auth would require a scope change.

## Key runtime contracts

- Daemon port: 47910 (fixed, from `@wadeck-app/singleton-daemon-kit` convention)
- orch-server base port: 47950 (increments on `EADDRINUSE`)
- Daemon ↔ orch-server: HTTP RPC via daemon SDK, never direct imports
- Idle shutdown signal: `{ "type": "idle-exit" }` written to orch-server stdout (newline-delimited JSON)
- Dashboard port file: `<configDir>/config.dashboard` (JSON: `{ port, pid, startedAt }`)
