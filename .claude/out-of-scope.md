# Out of Scope — orchestrator

Checked against the code on 2026-11-07.

## Dashboard: excluded and shipped

| Item | State |
|---|---|
| Duration trending / sparklines | Excluded. Per-run resource charts exist (`ResourceHistory`); no duration sparkline |
| Schedule timeline | Shipped for the next 24 h (`ScheduleTimeline`). A Gantt of past runs is still excluded |
| Overlap / conflict detection | Excluded (not found in the dashboard) |
| Import / export job definitions | HTTP API only (`GET /api/jobs/export`, `POST /api/jobs/import` in orch-core, served by `orch-server`). No page uses it and the app-core module does not publish it |
| Dry-run | A script-declared dry run shipped (`dryRunSupported`, `POST /api/jobs/:id/dry-run`). A sandboxed preview of an arbitrary command stays excluded |
| Advanced job fields: `liveness`, `onExitCode`, `missedFiring` | Shipped in the job form and the config display |

## Authentication / multi-user

Dashboard is local-only (127.0.0.1 binding, single local machine owner assumed). No authentication exists — accepted risk per Decision #13. See `threat-model.md` T-02.

## Remote / network access to the dashboard

Dashboard binds only to 127.0.0.1. Remote access is a scope change, not a configuration option.

## Daemon control from the dashboard

Neither `orch-server` nor the app-core module exposes daemon quit, stop or restart. `orch-server` proxies job management (CRUD, trigger, kill, enable/disable, `restart-job`), read-only status, logs, secrets and exec through the daemon RPC; the app-core module publishes the same minus secrets, exec, import/export, heartbeat and events. `POST /api/jobs/:id/restart` restarts a job, not the daemon. Admin-level daemon control remains CLI-only.

## Progress / ETA

No external strategy code is loaded: strategies are built in and declarative (`threat-model.md` T-04). A job reports through the `##orch-progress` convention, not through code orch runs.

## Scope change process

Raising any excluded item as a requirement is a scope-change conversation. Keep this file in line with the code: when an item ships, say so in the table.
