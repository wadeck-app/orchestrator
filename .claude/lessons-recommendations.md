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

<!-- consolidated 2026-09-16 -->
I'll synthesize the lessons into actionable recommendations grouped by category.

## Documentation
- [ ] Document log directory structure (logs/daemon, logs/tray, logs/jobs) and DailyLogger initialization paths in daemon-config.md
- [ ] Document platform-specific launcher binary resolution pattern (orchestrator-cli-{win32-x64,darwin-arm64,darwin-x64}) in CLAUDE.md or .claude/
- [ ] Document Node.js engine version strategy, EBADENGINE rollback behavior, and version progression rules in guiding-principles.md
- [ ] Create DSL pattern reference documenting: data fetching ($sources vs useState), component Props naming requirements (XxxProps not Props), and $brains/$outputs callback patterns
- [ ] Add troubleshooting guide for deferred tool "NOT YET KNOWN" errors with recovery steps (check MCP connection, use ToolSearch, fallback patterns)
- [ ] Document violations check workflow: run without suppression as final gate, suppress-start/suppress-end syntax for multi-line suppressions
- [ ] Create architectural map in docs/ showing package relationships and feature flows (cli → orch-server → orch-app → orch-ui)
- [ ] Document scraper environment configuration: .env.local copy pattern, Chrome profile location in data dir
- [ ] Document CI polling best practices: use poll-ci skill first, exponential backoff for npm publish waits, ScheduleWakeup for long waits (270s cache-warm, 1200s+ cache-cold)
- [ ] Document test infrastructure patterns (vitest.config, MSW, jsdom, test-setup.ts) as reusable template

## Process
- [ ] Enforce ToolSearch call before first use of any deferred tool (add pre-flight check to avoid "NOT YET KNOWN" cascade)
- [ ] Replace tight npm view polling loops (7-10s intervals) with ScheduleWakeup: 270s for cache-warm waits, 1200s+ for publish/CI waits
- [ ] Add mandatory verification step after subagent delegation: read delivered files/changes before reporting success to user
- [ ] Establish debugging discipline: change one variable at a time, observe result, then proceed (no parallel speculative changes)
- [ ] Ban silent fallbacks (return '0.0.0-dev', return null, skip if missing) - enforce fail-fast with clear error messages
- [ ] Require explicit "PARTIAL IMPLEMENTATION" banner at top of response when delivered scope is incomplete or depends on missing pieces
- [ ] Add global npm package installation to always-ask checklist (never install without explicit user approval)
- [ ] Clean up temporary investigation files (test-*.js, scratch scripts) immediately after use or in same session
- [ ] Require live UI testing (browser interaction or curl) before claiming frontend feature is complete - type checking ≠ feature correctness
- [ ] Run violations check without grep filters/suppression as final commit gate to catch all violations
- [ ] For updater/integration testing: admit upfront when full integration test is infeasible, test pieces explicitly, don't claim comprehensive coverage

## Code comments
- [ ] Add comment above Windows launcher binary path calculation in startup.ts explaining require.resolve() for platform-specific packages
- [ ] Add comment in tray-manager.ts startup flow explaining Windows registry manipulation and SW_HIDE EPIPE risk from closed stdout pipes
- [ ] Add comment above DailyLogger instantiation sites explaining configDir-relative path scheme (logs/daemon, logs/jobs/*, logs/tray)
- [ ] Add comment in updater entry.ts explaining semver engine check contract and rollback trigger conditions

## Configuration
- [ ] Automate asset sync: add build script step copying orch-app/dist/assets → orchestrator-cli/server/public/assets
- [ ] Create test utilities package (@wadeck-app/orchestrator-test-utils) for engine/updater verification to replace ad-hoc test-*.js scripts
- [ ] Add integration test coverage for cross-version scenarios: engine mismatch, EBADENGINE rollback, daemon self-check failure
- [ ] Add ESLint rule for DSL apps: detect useState/useEffect data fetching, require YAML $sources instead
