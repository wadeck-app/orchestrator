# Threat Model — orchestrator

STRIDE analysis of the dashboard surface.

## Scope

`orch-server` exposed on `127.0.0.1` by the orchestrator daemon on demand, and the same routes published by the app-core module: the REST API (job management, logs, secrets, exec, open), SSE log streaming and static SPA serving. There is no authentication (Decision #13, T-02).

## Assets

| Asset | Sensitivity |
|---|---|
| Job registry (`registry.json`) | High — job definitions contain arbitrary shell commands and cwd paths |
| Log files | Medium — may contain command output, env values, or secrets printed by jobs |
| Daemon control (quit/restart via RPC) | High — orch-server does NOT expose these (`POST /api/jobs/:id/restart` restarts a job, not the daemon) |
| Secrets store | High — `/api/secrets` is served by orch-server only; the app-core module does not publish it |

## Mitigations

| ID | Threat | Mitigation | Status |
|---|---|---|---|
| T-01 | Path traversal on log endpoint | `jobId` validated as `/^[a-z0-9-]+$/i`; log files are looked up by listing the job's log folder (`listLogFiles` / `findLatestLogFile` in `orch-core/src/routes/logs.ts`: `<id>-<stamp>.log` and rotated segments), with no other user-controlled segment | Mitigated |
| T-02 | Any localhost process can call job write/trigger endpoints | Accepted risk (v1): single-user local machine; all local processes under the same OS session already have full access to registry files directly | Accepted |
| T-03 | CSRF — malicious page sends cross-origin requests | Accepted risk (v1): same rationale as T-02; `@fastify/cors` added as best-effort only | Accepted |
| T-04 | progress: no external code is loaded; log patterns are regexes run on the job's own log lines, bounded in length and time | Strategies are built in (patterns and JSON only), no plugin loading. Patterns: at most 200 characters, no backreference, nested quantifier or overlapping alternation under a quantifier (rejected when configured); a log line is cut to 2000 characters; each batch runs under a 500 ms V8 timeout and a pattern that times out is skipped for 20 calls. Option payloads are capped at 16 KB. `packages/orchestrator-cli/src/progress/safe-regex.ts` | Mitigated |
| T-05 | Endpoints that run something on the machine: `POST /api/exec` (arbitrary command), `/api/jobs/:id/trigger`, job create/update (commands), `/api/jobs/import`, `GET /api/open` (starts a program) | Same exposure as T-02: any local process can already run commands as the same OS user. `/api/open` is limited to documents and folders, no shell, not from another site (`orch-core/src/routes/open.ts`). `/api/exec` and `/api/secrets` are not published by the app-core module | Accepted (T-02) |

## STRIDE summary

- **Spoofing**: not addressed; no authentication (T-02)
- **Tampering**: write endpoints are open to any local process (T-02, T-03); job payloads validated by daemon's `validateJob`
- **Repudiation**: not addressed in v1; daemon log rotation provides post-hoc record
- **Information Disclosure**: T-01 mitigated; no other sensitive data served by orch-server
- **Denial of Service**: not a primary concern; 127.0.0.1 binding limits exposure; no rate limiting in v1
- **Elevation of Privilege**: orch-server does not expose daemon control (quit/restart); runs under the same OS user as daemon

## Key constraints that must not be changed without a threat model review

- `orch-server` must bind to `127.0.0.1` only — never `0.0.0.0`
- `jobId` regex validation (`/^[a-z0-9-]+$/i`, `JOB_ID_RE` in `orch-core/src/routes/logs.ts`) is a security control, not cosmetic
- `orch-server` must not expose daemon quit/restart RPC commands
