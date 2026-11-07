# Guiding Principles — orchestrator

They apply to all packages in this workspace.

## P-1: Daemon stability takes priority over server convenience

The daemon (`orchestrator-cli`) must never depend on `orch-server` being alive. `orch-server` is a disposable child process. If it crashes, the daemon catches the `close` event, cleans up `config.dashboard`, and continues running. Never couple job execution to dashboard availability.

## P-2: localhost-only binding (non-negotiable)

`orch-server` binds exclusively to `127.0.0.1`. `0.0.0.0` is never acceptable. The dashboard has write access to the job registry and can trigger shell commands; network exposure without authentication is a critical security boundary violation.

## P-3: On-demand resource use — idle shutdown is mandatory

`orch-server` must shut itself down when idle. The idle timer resets on API requests, `POST /api/heartbeat`, and active SSE connections. Static asset requests do not reset the timer. Default timeout: 10 minutes (configurable via `ORCH_DASHBOARD_IDLE_TIMEOUT_MS`). This is not optional. It applies to `orch-server`; the app-core module has no idle exit (it passes a no-op timer).

## P-4: Dashboard replaces the terminal for day-to-day operations

All actions a user would normally do in a terminal for daily orchestrator use must be available in the v1 UI. Features still without UI (sparklines, Gantt, import/export UI; see `out-of-scope.md`) must not be removed from the underlying data model — keep fields, defer the UI only.

## P-5: Reuse over reinvention

Use existing workspace packages as-is: `@wadeck-app/dsl-renderer`, `@wadeck-app/dsl-ui`, `@wadeck-app/singleton-daemon-kit` (port-file conventions, daemon client). Use Fastify with `@fastify/static` (matches agent-fleet pattern). Custom alternatives require a concrete gap justification, not preference.

## P-6: orchestrator-cli must not be imported by the dashboard packages at source level

All runtime communication is via HTTP (daemon RPC). The dependency graph is one-way: orch-server and the app-core module call the daemon's SDK RPC server through `orch-core`'s `DaemonProxy`; orchestrator-cli spawns orch-server as a child process. No direct TypeScript imports from `orch-server`, `orch-core` or `app-module-orchestrator` into `orchestrator-cli`, nor the reverse. `orch-core` holds the route logic both controllers share and imports neither Fastify nor app-core (guarded by a test); `app-module-orchestrator` never imports `orch-server`.

## P-7: jobId path parameter must be validated before constructing any file path

`/^[a-z0-9-]+$/i` (`JOB_ID_RE` in `orch-core/src/routes/logs.ts`) — reject anything else with 400. This is the log path traversal guard. Any new route that builds a path from a job id must apply it. Do not relax this regex without a full security review.

## P-8: orch classifies a job from the outside and takes the program at its word

orch observes a job's exit code and process lifetime; it never models what the job did. `skipExitCodes` declares how to classify a code, not a guarantee that nothing happened: a program that does work before checking its own lock exits "skipped" having changed state anyway. A classification is therefore never treated as evidence: the real exit code and the child's stderr always stay in the run history and the per-run log, which is where the truth about a run lives. Reject any feature that requires orch to understand what happens inside a job.

## Working rules

- Read the spec (`specs/`) before proposing an alternative approach: the DSL + capability-framework pattern for pages is decided there.
- Bug fixes are test-first: write a failing test that reproduces the bug, see it fail, fix, see it pass.
- Test with the installed `orch`, not the dev monorepo: `node_modules` resolution differs and the dev environment can pass while the installed one fails.
- Test endpoints with a browser or curl before claiming they work: passing internal API tests does not prove the boundary users see.
- Check `C:\Workspace_Tooling\ci-templates` for reusable workflows before writing a custom CI workflow.
- Never hand-copy `dist` into the global install: it produced a "verified" start-at-login that was broken in the published artefact. Publish through CI, move the install with `orch cli update`, then test. To try a change before publishing, run `node packages/orchestrator-cli/bin/orch.js <cmd>` so the path shows it is not the installed one.
- The daemon SDK wraps every response in `{ok: true, result: <data>}`: unwrap before consuming.
