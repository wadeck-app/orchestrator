# Threat Model -- Orch Web Dashboard

**Version:** 1.1
**Date:** 2026-08-31
**Methodology:** STRIDE

## Scope

The local web server (orch-server) exposed on 127.0.0.1 by the orchestrator daemon on demand. Covers the REST API (read/write jobs, trigger, read logs), SSE log streaming, static SPA asset serving, and the startup token / session cookie authentication flow.

## Assets

What we are protecting:

| Asset | Sensitivity | Owner |
|---|---|---|
| Job registry (registry.json) | High -- job definitions include arbitrary shell commands and cwd paths | daemon process |
| Log files | Medium -- may contain command output, environment values, or secrets printed by jobs | daemon process |
| Daemon control (quit/restart via RPC) | High -- administrative; orch-server does not expose these | daemon process |
| Port binding on localhost | Low -- local-only | OS |
| Startup token | High -- single-use; grants session access if intercepted before first browser load | daemon process |

## Threat Actors

| Actor | Motivation | Capability |
|---|---|---|
| Malicious local process or website (CSRF) | Add/delete jobs, trigger arbitrary commands | Can reach 127.0.0.1 from localhost via JS fetch if CORS is not locked down |
| Other local users on the same machine | Read logs, tamper with jobs | Can connect to any open localhost port |

## STRIDE Analysis

### Spoofing
Mitigated by the startup token + session cookie flow. The token is generated fresh at each spawn and passed only via the CLI arg and the initial browser URL. A second process cannot obtain the token without reading daemon memory or intercepting the URL.

### Tampering
Write endpoints (POST, PUT, DELETE /api/jobs) require a valid session cookie (`HttpOnly; SameSite=Strict`). The cookie cannot be set by a cross-origin page. Job payloads are validated server-side by the daemon's existing `validateJob` before write.

### Repudiation
Not addressed in v1. The daemon's existing log rotation provides a post-hoc record of job executions. Dashboard-initiated actions are indistinguishable from CLI-initiated actions in the current log format -- acceptable for a single-user local tool.

### Information Disclosure
Log endpoint validates `:jobId` as `/^[a-z0-9-]+$/i` before constructing the file path. Path traversal (e.g., `../`) is rejected with 400. Only files under `<configDir>/logs/` are served.

### Denial of Service
Not a primary concern for a single-user local tool. orch-server binds only to 127.0.0.1, limiting exposure to the local machine. No rate limiting in v1.

### Elevation of Privilege
orch-server does not expose daemon control commands (quit, restart). It only proxies job CRUD and trigger commands via the daemon RPC. The session cookie requirement prevents unauthenticated access from other local processes. orch-server runs under the same OS user as the daemon, so no privilege escalation is possible beyond what the daemon already allows.

## Mitigations

| ID | Threat category | Threat description | Mitigation | Status | Decision # |
|---|---|---|---|---|---|
| T-01 | Information Disclosure | Log files served via path parameter; risk of path traversal exposing files outside configDir/logs/ | orch-server validates jobId with `/^[a-z0-9-]+$/i`; file path constructed as `path.join(configDir, 'logs', jobId + '.log')` with no user-controlled segments beyond the validated ID | Mitigated | 11 |
| T-02 | Elevation of Privilege | Any localhost process can call job write or trigger endpoints | Accepted risk (v1): single-user local machine; all processes running under the same OS session already have full access to the job registry and config files directly. No auth added. | Accepted | 13 |
| T-03 | Tampering / CSRF | Malicious page sends cross-origin requests to job write endpoints | Accepted risk (v1): same rationale as T-02; other local processes are already trusted. CORS headers added via @fastify/cors as a best-effort measure only. | Accepted | 13 |

## Open Security Questions

*(none)*
