# Guiding Principles — orchestrator

These are sourced from the spec at `.claude/specs/2026-08-31_orch-web-dashboard/guiding-principles.md` and the architecture decisions recorded in that spec. They apply to all packages in this workspace.

## P-1: Daemon stability takes priority over server convenience

The daemon (`orchestrator-cli`) must never depend on `orch-server` being alive. `orch-server` is a disposable child process. If it crashes, the daemon catches the `close` event, cleans up `config.dashboard`, and continues running. Never couple job execution to dashboard availability.

## P-2: localhost-only binding (non-negotiable)

`orch-server` binds exclusively to `127.0.0.1`. `0.0.0.0` is never acceptable. The dashboard has write access to the job registry and can trigger shell commands; network exposure without authentication is a critical security boundary violation.

## P-3: On-demand resource use — idle shutdown is mandatory

`orch-server` must shut itself down when idle. The idle timer resets on API requests, `POST /api/heartbeat`, and active SSE connections. Static asset requests do not reset the timer. Default timeout: 10 minutes (configurable via `ORCH_DASHBOARD_IDLE_TIMEOUT_MS`). This is not optional.

## P-4: Dashboard replaces the terminal for day-to-day operations

All actions a user would normally do in a terminal for daily orchestrator use must be available in the v1 UI. Features deferred to v2 (sparklines, Gantt, import/export, liveness fields) must not be removed from the underlying data model — keep fields, defer the UI only.

## P-5: Reuse over reinvention

Use existing workspace packages as-is: `@wadeck-app/dsl-renderer`, `@wadeck-app/dsl-ui`, `@wadeck-app/singleton-daemon-kit` (port-file conventions, daemon client). Use Fastify with `@fastify/static` (matches agent-fleet pattern). Custom alternatives require a concrete gap justification, not preference.

## P-6: orch-server and orchestrator-cli must not import each other at source level

All runtime communication is via HTTP (daemon RPC). The dependency graph is one-way: orch-server calls the daemon's SDK RPC server; orchestrator-cli spawns orch-server as a child process. No direct TypeScript imports between them.

## P-7: jobId path parameter must be validated before constructing any file path

`/^[a-z0-9-]+$/i` — reject anything else with 400. This is the log path traversal guard. Do not relax this regex without a full security review.
