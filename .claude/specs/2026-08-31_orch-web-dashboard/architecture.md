# Architecture -- Orch Web Dashboard

**Version:** v0.1
**Last updated:** 2026-08-31
**Status:** Draft

## Overview

The dashboard adds a local web UI to the orchestrator daemon. It is implemented as three new packages alongside the existing CLI package. The daemon manages the web server as an on-demand child process; it does not embed web-serving logic itself.

## Package Structure

```
orchestrator/
  package.json                  (workspace root, private)
  packages/
    orchestrator-cli/           (existing -- daemon + CLI binary)
    orch-server/                (new -- Fastify HTTP server, serves SPA + REST API)
    orch-ui/                    (new -- React + Tailwind domain components)
    orch-app/                   (new -- Vite SPA, depends on orch-ui + @wadeck-app/dsl-ui)
```

### Package responsibilities

| Package | Responsibility | Key deps |
|---|---|---|
| orchestrator-cli | Daemon process, CLI commands, job scheduler, tray manager, dashboard process manager | @wadeck-app/singleton-daemon-kit |
| orch-server | Fastify HTTP server: serves orch-app static files + REST API; calls daemon RPC for data | fastify, @fastify/static, @fastify/cors, @wadeck-app/singleton-daemon-kit (client only) |
| orch-ui | Reusable React components scoped to orchestrator domain (JobCard, LogViewer, etc.) | @wadeck-app/dsl-ui, @wadeck-app/dsl-renderer, react, tailwindcss |
| orch-app | Vite SPA: pages, routes, API fetcher, heartbeat, idle-aware client | @wadeck-app/orch-ui, @wadeck-app/dsl-ui, @wadeck-app/dsl-renderer, react-router-dom |

### Dependency graph

```
orchestrator-cli  (no dep on orch-*)
orch-ui           --> @wadeck-app/dsl-ui, @wadeck-app/dsl-renderer
orch-app          --> orch-ui, @wadeck-app/dsl-ui, @wadeck-app/dsl-renderer
orch-server       --> (no dep on orch-ui or orch-app source; orch-app dist/ is served as static files)
```

orch-server and orchestrator-cli never import each other at the source level. All runtime communication is via HTTP (daemon RPC).

## Daemon <-> orch-server Lifecycle

### Spawn

The daemon spawns orch-server as a child process when the user clicks "Open Dashboard" in the systray (or when `orch dashboard` is called from the CLI). If the server is already running (port file present and fresh), the daemon skips spawning and just opens the browser.

Spawn command:
```
node packages/orch-server/dist/index.js
  --config-dir <configDir>
  --daemon-port <daemonPort>
  --base-port 47950
```

### Port file

On successful bind, orch-server writes `<configDir>/config.dashboard`:
```json
{ "port": 47951, "pid": 12345, "startedAt": "2026-08-31T21:00:00.000Z" }
```

The daemon reads this file to build the "Open Dashboard" URL: `http://localhost:<port>`.

### Idle shutdown

orch-server maintains an idle timer (default 10 min, configurable via `ORCH_DASHBOARD_IDLE_TIMEOUT_MS`). The timer resets on:
- Any `GET|POST|PUT|DELETE /api/*` request
- `POST /api/heartbeat` (SPA sends this every 30s while tab is visible)
- Any active SSE connection (connection presence resets timer; connection drop allows timer to resume)

Static asset requests (`GET /` and other non-API paths) do NOT reset the timer.

On idle timeout, orch-server:
1. Emits `{ "type": "idle-exit" }` to stdout (newline-delimited JSON, same pattern as tray-go IPC)
2. Deletes `config.dashboard`
3. Calls `server.close()` and exits

The daemon listens on the child process stdout for this message and updates the systray accordingly (removes port reference, marks dashboard as stopped).

### Daemon survival

The daemon never awaits orch-server. If orch-server crashes or is killed, the daemon catches the `close` event on the child process and cleans up `config.dashboard`. The daemon continues running normally.

## REST API Contract

All endpoints are served by orch-server under the `/api` prefix. orch-server proxies data by calling the daemon's SDK RPC server (see "Daemon RPC access" below).

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | /api/jobs | List all jobs with last RuntimeEntry |
| GET | /api/jobs/:id | Single job + last RuntimeEntry |
| POST | /api/jobs | Add job (body: Partial Job) |
| PUT | /api/jobs/:id | Edit job (body: Partial Job) |
| DELETE | /api/jobs/:id | Remove job |
| POST | /api/jobs/:id/trigger | Manually trigger job (fire-and-forget) |
| POST | /api/jobs/:id/enable | Enable job |
| POST | /api/jobs/:id/disable | Disable job |
| GET | /api/logs/:jobId/stream | SSE stream of job log file (history burst + live tail) |
| POST | /api/heartbeat | Browser liveness signal; resets idle timer; returns 204 |

### SSE log stream

`GET /api/logs/:jobId/stream` validates `:jobId` as `/^[a-z0-9-]+$/i` (job ID format); rejects any other pattern with 400. Serves `Content-Type: text/event-stream`. Sends historical lines as individual `data:` events, then switches to `fs.watch` for new lines. On client disconnect, the watch is closed and the SSE connection count is decremented (allowing the idle timer to resume if no other activity exists).

## Daemon RPC Access

orch-server reads `<configDir>/config.port` on startup to determine the daemon's SDK port. It then constructs a `createDaemonClient({ configDir, commands })` from `@wadeck-app/singleton-daemon-kit` and calls `client.send(command, payload)` for all job and state operations.

If `config.port` is absent or stale (mtime > 60s), orch-server returns `503 Service Unavailable` on all `/api/jobs` endpoints with body `{ "error": "daemon-not-running" }`.

## Security

| Control | Implementation |
|---|---|
| Localhost-only binding | `fastify.listen({ host: '127.0.0.1', port })` -- never 0.0.0.0 |
| No authentication (v1) | Accepted risk -- single-user local machine; all local processes already have full access to registry files. See Decision #13. |
| CORS | `@fastify/cors` with `origin: ['http://localhost:<port>']` -- best-effort only |
| Log path traversal | jobId validated as `/^[a-z0-9-]+$/i` before constructing log file path |

See `threat-model.md` for full STRIDE analysis.

## Decisions

| # | Decision | Rationale | Date |
|---|---|---|---|
| 3 | Web server is a separate child process | Daemon stability; mirrors tray-go pattern | 2026-08-31 |
| 4 | Base port 47950 with EADDRINUSE increment | Matches singleton-daemon-kit convention; supports multiple instances | 2026-08-31 |
| 5 | Fastify + REST; orch-server calls daemon RPC for data | No new IPC protocol; reuses existing RPC commands | 2026-08-31 |
| 7 | Idle shutdown with dual signal (API + heartbeat + SSE) | Resource efficiency; browser-close naturally triggers shutdown | 2026-08-31 |
| 8 | SSE for log streaming | Live tail UX; connection drop integrates with idle timer | 2026-08-31 |
| 9 | Four packages | One-responsibility-per-package; security boundary between server and CLI | 2026-08-31 |
