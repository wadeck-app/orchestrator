# Out of Scope — orchestrator

Source: `.claude/specs/2026-08-31_orch-web-dashboard/out-of-scope.md`. Items here are explicitly excluded from v1.

## Dashboard (v2 roadmap)

| Item | Reason |
|---|---|
| Duration trending / sparklines | Charting complexity not justified for v1 |
| Schedule timeline / Gantt view | Requires calendar component |
| Overlap / conflict detection | Requires schedule analysis logic |
| Import / export job definitions | Not a v1 priority |
| Dry-run command preview | Requires sandboxed execution context |
| Advanced job fields: `liveness`, `onExitCode`, `missedFiring` | Power-user fields; users can edit `registry.json` directly |

## Authentication / multi-user

Dashboard is local-only (127.0.0.1 binding, single local machine owner assumed). No authentication is added in v1 — accepted risk per Decision #13. See `threat-model.md` T-02.

## Remote / network access to the dashboard

Dashboard binds only to 127.0.0.1. Remote access is a scope change, not a configuration option.

## Daemon control from the dashboard

`orch-server` does not expose daemon quit/restart commands. It only proxies job CRUD and trigger commands via the daemon RPC. Admin-level daemon control remains CLI-only.

## Scope change process

Raising any excluded item as a requirement is a scope-change conversation. Do not modify `out-of-scope.md` silently — changes must be acknowledged as a versioned decision in the spec.
