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

## From lessons learned

- Read the spec (`specs/`) FIRST before proposing any alternative approach — the DSL + capability-framework pattern was in the spec and prior work but ignored repeatedly until the user reminded explicitly (session 508a6a16).
- TDD-first for all bug fixes: write a failing test that reproduces the bug, confirm it fails, fix code, confirm green — never push without a proven red→green cycle.
- Test with the installed `orch` binary, not the dev monorepo — node_modules paths and resolution differ; dev env can pass while installed env fails.
- Test actual endpoints with browser or curl before claiming they work — internal API tests passing does not prove the boundary users see is correct.
- `mcp__github-wadeck-app` and `mcp__github-wadeck` are READ-ONLY by design; writing via those MCP servers is intentionally impossible, not a config issue.
- Check `C:\Workspace_Tooling\ci-templates` for reusable workflows (e.g., `publish-npm.yml`) before writing any custom CI workflow.
- In spec mode: never change status from "In Review" to "Approved" without explicit user confirmation — "all questions resolved" means ready for review, not approved.
- In spec sessions: establish business requirements (what problem, who is impacted, what outcome) before any technical questions about ports, APIs, or processes.
- After every `git push`, use the `poll-ci` skill immediately — never fall back to manual `sleep + actions_list` loops; if poll-ci fails to load, report it as a blocker.
- Launch parallel agents for independent workstreams in a single message without asking for permission — the user's standing instruction is "autonomie" and "en parallèle quand possible" (session 0a4d8699).
- When debugging, change one thing at a time and observe the result — multiple speculative edits in parallel waste time and obscure root cause (15+ edits to index.ts before identifying the actual constraint, session 379d8f62).
- For directory clobber: use `cp -rT src dest` or `cp -r src/. dest` — `cp -r src dest/` when dest exists creates `dest/src/` nesting.
- Sync dist changes to BOTH the local workspace AND the global npm install location (`~/.nvm/v24.11.1/node_modules/`) — changes that only update one path appear to "not take effect".
- Deferred MCP tools must be loaded with `ToolSearch select:<name>` before any call — treat "NOT YET KNOWN" as a hard stop, not a soft retry; if ToolSearch itself fails, report the blockage rather than sleeping and retrying.
- The daemon SDK wraps all responses in `{ok: true, result: <data>}` — unwrap before consuming; this is not obvious from endpoint docs.
