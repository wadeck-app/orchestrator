# Threat Model — orchestrator

Sourced from `.claude/specs/2026-08-31_orch-web-dashboard/threat-model.md` (v1.1, 2026-08-31, STRIDE).

## Scope

`orch-server` exposed on `127.0.0.1` by the orchestrator daemon on demand. Covers REST API (job CRUD + trigger), SSE log streaming, static SPA serving, and the startup token / session cookie auth flow.

## Assets

| Asset | Sensitivity |
|---|---|
| Job registry (`registry.json`) | High — job definitions contain arbitrary shell commands and cwd paths |
| Log files | Medium — may contain command output, env values, or secrets printed by jobs |
| Daemon control (quit/restart via RPC) | High — orch-server does NOT expose these |
| Startup token | High — single-use; grants session access if intercepted before first browser load |

## Mitigations

| ID | Threat | Mitigation | Status |
|---|---|---|---|
| T-01 | Path traversal on log endpoint | `jobId` validated as `/^[a-z0-9-]+$/i`; path constructed as `path.join(configDir, 'logs', jobId + '.log')` with no other user-controlled segments | Mitigated |
| T-02 | Any localhost process can call job write/trigger endpoints | Accepted risk (v1): single-user local machine; all local processes under the same OS session already have full access to registry files directly | Accepted |
| T-03 | CSRF — malicious page sends cross-origin requests | Accepted risk (v1): same rationale as T-02; `@fastify/cors` added as best-effort only | Accepted |

## STRIDE summary

- **Spoofing**: startup token + session cookie flow; token is fresh per spawn, passed only via CLI arg and initial browser URL
- **Tampering**: write endpoints require valid session cookie (`HttpOnly; SameSite=Strict`); job payloads validated by daemon's `validateJob`
- **Repudiation**: not addressed in v1; daemon log rotation provides post-hoc record
- **Information Disclosure**: T-01 mitigated; no other sensitive data served by orch-server
- **Denial of Service**: not a primary concern; 127.0.0.1 binding limits exposure; no rate limiting in v1
- **Elevation of Privilege**: orch-server does not expose daemon control (quit/restart); runs under the same OS user as daemon

## Key constraints that must not be changed without a threat model review

- `orch-server` must bind to `127.0.0.1` only — never `0.0.0.0`
- `jobId` regex validation (`/^[a-z0-9-]+$/i`) on the log endpoint is a security control, not cosmetic
- `orch-server` must not expose daemon quit/restart RPC commands

## From lessons learned

- `config.port` persists on disk after the daemon stops — a stale file causes new server attempts to bind the wrong port; the dashboard must auto-start the daemon on demand rather than reading a stale config.
- Tray manager spawns duplicate instances on restart (`_scheduleRestart` logic) — multiple PIDs accumulate if restart cleanup is incomplete; killing by PID list is a symptom, not a fix.
- Multi-tier deployment: dist files must be synced to BOTH the local workspace path AND the global npm install path (`~/.nvm/.../node_modules/`) — partial sync silently serves stale code.
