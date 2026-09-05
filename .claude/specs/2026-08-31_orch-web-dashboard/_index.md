# Spec: Orch Web Dashboard

**Created:** 2026-08-31
**Version:** v0.1
**Status:** Approved -- v1.0 -- 2026-09-01
**Iteration:** 1

## Summary

Add a local web dashboard to the orchestrator daemon. A systray button opens a browser pointing to a localhost URL served by the daemon. The UI shows registered job configurations, recent run history, logs, and allows adding new jobs without editing the config file directly.

## Decision Log

| # | Decision | Status | Date | Rationale |
|---|---|---|---|---|
| 1 | Publish dsl-renderer + dsl-ui as @wadeck-app/dsl-renderer and @wadeck-app/dsl-ui from new repo wadeck-app/dsl-view (GitHub Packages) | Resolved | 2026-08-31 | Self-contained versioned packages; orchestrator references by version; no cross-repo file: path dependency |
| 2 | Full monorepo: move existing CLI into packages/orchestrator-cli, add packages/orch-ui and packages/orch-app | Resolved | 2026-08-31 | Clean separation, mirrors capability-framework structure, avoids root-as-package antipattern |
| 3 | Web server runs as a separate child process managed by the daemon; daemon survives web server restart; server spawned on demand (e.g. on "Open Dashboard" click) and stopped when no longer needed | Resolved | 2026-08-31 | Daemon stability; same lifecycle pattern as tray-go binary |
| 4 | Dashboard port: fixed base 47950, increment on EADDRINUSE (same pattern as singleton-daemon-kit 47900-47910); written to config.dashboard JSON file in configDir; daemon reads it back and passes URL to systray | Resolved | 2026-08-31 | Matches existing port-file pattern; supports multiple daemon instances |
| 5 | Web server HTTP stack: Fastify + @fastify/static + @fastify/cors, same as agent-fleet; REST API under /api/*; web server spawned with configDir + daemon port as CLI args, then calls daemon SDK RPC for job/state data | Resolved | 2026-08-31 | Matches agent-fleet precedent; no new IPC protocol needed -- reuses existing RPC |
| 6 | Systray "Open Dashboard" item: added between "status" section and "open-logs" separator; uses same shell-open pattern as open-logs (open/explorer.exe); spawns web server if not running, then opens http://localhost:<dashport> | Resolved | 2026-08-31 | Consistent with existing tray interaction model |
| 7 | Idle shutdown: web server exits after 10 min of inactivity; idle timer resets on EITHER an /api/* request OR a browser heartbeat (POST /api/heartbeat, sent every 30s while tab is visible via Page Visibility API); static asset requests do NOT reset timer; configurable via ORCH_DASHBOARD_IDLE_TIMEOUT_MS | Resolved | 2026-08-31 | Dual signal (HTTP activity + browser visibility) avoids false-idle when user is active but not polling, and false-active when browser is closed but a background fetch fires |
| 8 | Log streaming: SSE via GET /api/logs/:jobId/stream; active SSE connection counts as activity (resets idle timer); SSE drop on browser-close lets timer run; history served as initial SSE burst then fs.watch for new lines | Resolved | 2026-08-31 | Live tail UX; SSE connection presence is the third idle signal alongside API requests and heartbeat |
| 9 | Four packages: orchestrator-cli (existing), orch-server (new Fastify web server), orch-ui (new React components), orch-app (new Vite SPA); daemon spawns orch-server as a child process pointing at its dist/index.js | Resolved | 2026-08-31 | One-responsibility-per-package; web server cannot import CLI internals -- only reaches data via RPC |
| 10 | Business scope D: dashboard covers monitoring (last run status, next-fire countdown), configuration (add/edit/delete/enable/disable jobs), and debug (live log tail, manual trigger); user is the local machine owner | Resolved | 2026-08-31 | All three use cases confirmed |
| 11 | v1 feature set: job list with status + next-fire + enable/disable + manual trigger; job detail (config); log viewer (SSE); add/edit/delete form (core fields only: label, type, command, cwd, schedule/delay, enabled, triggerMode) | Resolved | 2026-08-31 | Keep v1 simple |
| 12 | v2 deferred: duration trending, schedule timeline/gantt, overlap detection, import/export, dry-run preview, advanced form fields (liveness, onExitCode, missedFiring) | Resolved | 2026-08-31 | Explicitly deferred to keep v1 scope tight |
| 13 | Security T-02/T-03 accepted risk (v1): no authentication on the dashboard; all local processes under the same OS session already have full access to registry files directly; @fastify/cors added as best-effort only | Resolved | 2026-08-31 | Single-user local tool; auth would add friction without meaningful protection gain |
| 14 | Security T-01 mitigated: log endpoint validates :jobId against /^[a-z0-9-]+$/i before constructing file path; path built with path.join(configDir, 'logs', jobId + '.log') -- no user-controlled segments beyond the validated ID | Resolved | 2026-08-31 | Simple input validation; validateJob already enforces this format on job IDs |
| 15 | Audit (full) completed -- 12 findings (2 critical, 4 high, 4 medium, 2 info) | Resolved | 2026-08-31 | See audits/2026-08-31_22-38_full/report.md |
| 16 | RunHistory descoped in v1: show single last RuntimeEntry only (matches existing State schema; no multi-entry history storage needed) | Resolved | 2026-08-31 | Keep v1 simple; State stores one entry per job |
| 17 | orch dashboard CLI command deferred to v2: systray "Open Dashboard" click is the only v1 trigger | Resolved | 2026-08-31 | Keep v1 simple |
| 18 | once job type in add form: no delayMs field; job fires immediately on add (delayMs=0 applied as default) | Resolved | 2026-08-31 | Keep v1 simple |

## Open Questions

| # | Question | Priority | Status |
|---|---|---|---|
| 1 | Frontend library coupling: how to reference dsl-renderer / dsl-ui | High | Resolved |
| 2 | Monorepo restructure: turn orchestrator into npm workspaces | High | Resolved (Decision #2) |
| 3 | Web server embedding: where does the HTTP server for the dashboard live | High | Resolved (Decision #3) |
| 4 | Port strategy: fixed base port with increment, or share SDK port | High | Resolved (Decision #4) |
| 5 | API design: new REST endpoints on embedded server vs new RPC commands | Medium | Resolved (Decision #5) |
| 6 | Systray "Open Dashboard" item: placement and open-browser mechanism | Low | Resolved (Decision #6) |
| 7 | Job add/edit via UI: form validation and schema alignment with validateJob | Medium | Resolved (Decision #11) |
| 8 | Log streaming: how to stream live logs to the browser | Medium | Resolved (Decision #8) |
| 9 | RunHistory data model: extend State for N entries or show single last entry in v1 | High | Resolved (Decision #16) |
| 10 | orch dashboard CLI command: v1 or v2 | Medium | Resolved (Decision #17) |
| 11 | once job delay field (delayMs) in add form: expose or fire immediately | Low | Resolved (Decision #18) |

## Modules / Sub-files

| File | Contents |
|---|---|
| `guiding-principles.md` | P-1 through P-5: daemon stability, local-only, on-demand, feature parity, reuse |
| `out-of-scope.md` | v2 deferred items + remote access exclusion |
| `threat-model.md` | STRIDE analysis; T-01/T-02/T-03 all mitigated |
| `architecture.md` | Package structure, daemon lifecycle, REST API contract, security controls |
| `frontend.md` | orch-ui components, orch-app routes, dsl-renderer integration, heartbeat hook |

## Changelog

| Version | Date | Summary |
|---|---|---|
| v0.1 | 2026-08-31 | Initial spec created |
| v3.0 | 2026-09-05 | v3 scope approved: event queue, notifications, monitoring, tags, dark mode, WebSocket |

## v3 Decisions (2026-09-05)

| # | Decision | Status | Rationale |
|---|---|---|---|
| 18 | Event queue integration: all job lifecycle events pushed to queue daemon (localhost:47910) via fire-and-forget POST | Resolved | Decouples notifications, webhooks, SSE from scheduler; queue handles retries and DLQ |
| 19 | Job tags/labels with deterministic color palette (6 colors, hash-based) | Resolved | Tag → filter in UI; color makes quick visual scanning easier |
| 20 | Per-job environment variables stored in registry.json, merged with process.env at spawn | Resolved | Scrapers need custom env without modifying global environment |
| 21 | Timezone shown at global level only, defaults to OS timezone (Intl.DateTimeFormat) | Resolved | Per-job timezone would be confusing; global OS default is the right expectation |
| 22 | Job dependencies: A→B supported; complex DAGs are a "flow" use case, out of scope | Resolved | See guiding-principles.md P3 |
| 23 | Anomaly detection: alert if duration > 3× rolling average (configurable) | Resolved | Catches stuck scrapers without requiring manual SLA config per job |
| 24 | WebSocket real-time transport replaces SSE polling; plan exists at .claude/plans/2026-09-05_realtime-transport.md | Pending | Reduces latency and server load; complex implementation requires dedicated plan |
| 25 | Dark mode: full CSS variable inversion; plan exists at .claude/plans/2026-09-05_dark-mode.md | Pending | Requires agent-browser validation for contrast |
