# Recommendations

<!-- consolidated 2026-09-01 -->
Based on both the provided lessons and the project-local file, here are the synthesized recommendations:

---

**Documentation**
- [ ] Document that `mcp__github-wadeck-app` and `mcp__github-wadeck` are read-only by design — add a note in `.claude/kb/` or project README so agents stop attempting writes via those servers.
- [ ] Document the daemon SDK response envelope `{ok: true, result: <data>}` in a code comment at the proxy/unwrap call site, not just in the KB.
- [ ] Document the `ci-templates` location (`C:\Workspace_Tooling\ci-templates`) and reusable workflow names (e.g. `publish-npm.yml`) so agents find them before writing custom workflows.
- [ ] Document that `config.port` persists after daemon stops and can cause stale-server issues — add a comment in the config read path.

**Process**
- [ ] Use TDD strictly for bug fixes: write a failing test that reproduces the bug, confirm it fails, then fix — never push without a proven red→green cycle.
- [ ] Use the `poll-ci` skill immediately after every push instead of manual `sleep + actions_list` loops; if the skill fails to load, treat that as a blocker and report it rather than falling back to sleep polling.
- [ ] Start every spec session with business requirements questions before any technical architecture questions (what problem, who is impacted, what outcome) — never open with ports/APIs/processes.
- [ ] In spec mode, never change status from "In Review" to "Approved" without explicit user confirmation; "all questions resolved" means ready for review, not approved.
- [ ] Test features with the installed `orch` binary and actual browser/curl, not just the dev monorepo environment — dev paths differ from installed package paths.

**Code comments**
- [ ] Add a `// @formatter:off` comment block above any non-standard `cp` invocation (e.g. `cp -rT` for clobber) explaining why the flag is needed to avoid regression.
- [ ] Add a comment at every npm workspace `require`/`import` that relies on hoisting behavior, noting that resolution goes to workspace root `node_modules/`, not the local package.

**Configuration**
- [ ] Validate dist-tag consistency at publish time: assert that `compute-version` output tag matches the tag consuming packages install from (`latest` vs `edge`) — fail the CI step loudly if mismatched.
- [ ] Add a `ToolSearch` usage note in the agent skills or KB: deferred MCP tools must be fetched with `select:<name>` before any call — treat a "NOT YET KNOWN" result as a hard stop, not a soft retry.
