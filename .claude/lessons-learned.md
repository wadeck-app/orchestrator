# Lessons learned

<!-- Last updated: 2026-09-05T20:38:55.580Z -->

## Recurring feedback

<!-- session 9bc60855 2026-09-05 -->
- Invisible Node.js stderr in hidden process must be captured to daemon logs. Startup errors were lost because uncaught exceptions/unhandled rejections not wired to logger before crash.
- Violations suppress comment format (`shared/no-emoji,shared/no-unicode-symbol` on one line) was assumed but incorrect — requires individual suppress lines per rule. Format is not self-evident.
- Dark mode UI fixes (badge colors, text contrast) required screenshot verification; TypeScript/linting did not catch these visual regressions.
- Parallel agents on same repo can cause file contention; check-parallel-agents skill was invoked to diagnose potential locks.
- Component decomposition + glue-logic extraction into YAML callbacks appeared twice (job-list, job-detail) — extraction pattern (callback props → $brains in YAML) should be templated/documented for future DSL pages.

<!-- session 379d8f62 2026-09-02 -->
- Excessive file checking and grepping without clear investigation direction. Many commands like `grep "routes\|register" <file>` didn't advance debugging — a single read of the actual source file would have been faster than cumulative grep attempts.
- Heavy cycle of `orch stop/restart/server start/taskkill` with increasing desperation (10:24-10:38) — pattern suggests tray manager spawning multiple instances and not cleaning up cleanly; real issue (process state machine in tray-manager.ts) took explicit testing/fix to uncover.
- Massive debugging effort on scrapers (whatsapp/chatgpt) with no clear hypothesis — searching debug package internals, Chrome profile locations, locks, environment vars in scattered locations (12:13-13:27) — indicates missing integration docs or runbook for scraper setup in orchestrator context.
- Integration tests added via bash `cat >>` append rather than programmatic generation; feedback loop was add-test → run → grep-parse-failures → targeted-edit → repeat across 13+ test fixes

<!-- session a67e2f61 2026-09-01 -->
- Multiple iterations on daemon startup tests and self-check logic suggest test-driven incremental approach — write test, observe failure, fix code, repeat — which is fine but indicates the startup flow wasn't fully specified upfront

<!-- session 508a6a16 2026-09-01 -->
- User repeatedly corrected: DSL + capability-framework pattern was in spec and prior work but agent didn't apply it without explicit reminders. Pattern: spec exists → check it FIRST before proposing alternatives.
- User interrupted multiple times with frustration signals ("MAU VAISE QUALITE", repeated question marks). Root cause: agent claimed completion/progress before requirements were verified (e.g., "plan done" but DSL not used, tests passing but violations unfixed).
- User escalated mid-task: "corrige aussi les warnings !" — violations check was expected to fix warnings, not just report them.
- User repeatedly requested "full content with line numbers" instead of assistant summaries/excerpts — indicates preference for raw source to analyze rather than filtered output.
- Extended violations fixing required multiple mechanical grep/sed/violations-check cycles without clear end-state tracking. Agent repeatedly checked same violations instead of batching fixes then verifying once — suggests need for upfront violation categorization or systematic batch-fix-then-verify pattern rather than fix-check-fix cycles.

<!-- session 0a4d8699 2026-08-31 -->
- User stated "autonomie" and "en parallèle quand possible" multiple times — expects parallel agent work without permission-asking when options exist. This was a standing instruction, not a one-time clarification.
- TDD-first approach required: write failing test to reproduce bug, verify it fails, then fix. Do not push fixes without proven test failure + green after fix.
- Test with installed binary (`orch` command), not just local dev environment. Dev monorepo has different node_modules/paths than installed package.
- Test the actual UI in browser/curl, not just assume API works. Catch bugs at the boundary users see, not in internal endpoints.
- User sent explicit SendMessage coordination to fork agent to "abort git commit/push" then "git add ok, stop before commit" (lines 20:48:06-26) — suggests user prefers explicit review gate on autonomous git operations in sensitive contexts, or fork agent's git planning needs user approval before execution
- Repeated pattern of push → sleep 10-90s → retry broken CI checks. Agent doesn't have working CI polling despite poll-ci skill being available. Consider automatic fallback to poll-ci skill when GitHub MCP tools fail.

## Agent errors

<!-- session 9bc60855 2026-09-05 -->
- Log location not initially known — assistant searched many paths before user corrected: `~/.config/orchestrator` is the standard config dir. Should be documented in CLAUDE.md or threat-model.
- Dead `.tsx` page files left in `packages/orch-app/src/pages/` violated DSL-only design principle — user explicitly rejected non-YAML pages. Codebase should have been cleaned on migration.
- Created local violations rule `no-unicode-symbol.ts` when user explicitly rejected it ("pas de local rule") and demanded improving global `shared/no-emoji` in violations-framework instead.
- NOTIF-01 webhook implemented as HTTP subscriber store + external URL callbacks, but user requirement was event-queue-only (CLI triggering), no HTTP at all. Scope misread upfront.
- Test `makeCommands()` calls missed new `configDir` parameter during recent refactor — API contract not propagated to all call sites.
- Timestamp misread: assistant checked log entries at 14:23:57 when user clarified crash was "18h environ" (16h UTC). Did not ask user to confirm timezone interpretation before analyzing logs.
- Partial fix → regression: fixed only 2 `process.stderr.write` calls in scheduler.ts, believing that was root cause. Later discovered the real culprit was `console.log` in index.ts. Required second round of EPIPE suppression at module level to actually solve the crash.
- Speculative debugging cascade: hypothesized port conflict → Go launcher JobObject handling → EPIPE. Multiple dead-end investigations before pinpointing the actual root cause (stdout pipe closing in hidden launcher window). Wasted ~3 rounds of testing on wrong angles.
- Vitest alias resolution debugging used trial-and-error with repeated config edits (07:31-07:32) rather than investigating actual module paths first; agent made 4 sequential attempts with different assumptions without validating intermediate failures.
- Fork agent (a5c9) had to coordinate cross-workspace changes (fixing capability-framework dsl-renderer while main session worked in orchestrator) — no upfront discovery of which files were in dependency vs. local
- Component registry category generation fails silently when Props interface naming is wrong — type errors only surfaced after full build, late-stage detection
- MON-05 resource baseline calculation required mid-stream correction: should filter to only successful runs (exitCode === 0), not all runs — agent did not initially apply this constraint.
- Multiple fixed-interval sleep-retry loops (sleep 30-40s + orch status) for daemon startup; should check logs immediately before retrying, not after delays.
- Webhook feature implemented without request — agent should have confirmed scope explicitly before building features not in the task description; removal took multiple commit rounds.

<!-- session 379d8f62 2026-09-02 -->
- Extended trial-and-error debugging without establishing clear hypotheses first. Assistant made ~15+ speculative edits to orch-server/src/index.ts, routes/events.ts, and routes/logs.ts (changing wildcard option, hijack vs raw.writeHead, route registration order) before understanding the actual constraint: @fastify/static with wildcard:true was interfering with custom API route handlers.
- Multiple attempts at fixing supports-color dependency by manually copying it (12:31:29-12:32:19), but real root cause of scraper failures was likely environment configuration (.env.local missing), not dependency issues — wasted 15+ minutes on wrong diagnosis.
- Repeated use of wrong port (47951) in curl requests when correct port is 47950, even after checking config multiple times — indicates insufficient verification before repeating commands.
- Attempted to use unavailable `check-parallel-agents` skill to diagnose file lock issues during parallel agent work (19:25) — skill either missing from environment or not loaded in this session

<!-- session a67e2f61 2026-09-01 -->
- MCP tools `mcp__github-wadeck-app__actions_list` and `get_job_logs` repeatedly showed "NOT YET KNOWN" warnings — tool schemas failed to load, causing wasted polling attempts instead of clean retries
- Spawned fork subagent at 18:28:07 to read spec session history when main agent could have searched directly. Fork agents should parallelize independent work, not linear tasks the main agent handles.
- Manual verification of type re-exports (checking MissedFiring at 19:02:46, then editing index.ts). Suggests missing linting rule or automated export verification for shared types.

<!-- session 508a6a16 2026-09-01 -->
- Initial analysis claimed plan was complete despite DSL architectural requirement being unimplemented; should have cross-checked spec against code structure before providing summary.
- Parallel fork agents worked on overlapping files (JobCard.tsx modified by agent while another prepared changes); coordination via note-passing but no explicit verification of final merge state.
- SSO session expiration (`aws sso login` expired) blocked reads from C:\Workspace_Other\capability-framework twice — credentials issue went undiagnosed; user worked around by requesting direct file reads.
- Repeated `mcp__github-wadeck-app__actions_list` failures (marked "NOT YET KNOWN" for list_workflow_runs/list_workflow_jobs methods) forced agent to resort to `sleep` commands for CI polling instead of fixing tool schema issue.
- subprocess skill invocation failed with "NOT YET KNOWN" at 20:35:05 — agent attempted to delegate violation review but skill was unavailable or misconfigured. Constraint: subprocess skill may not be listed or accessible in this project context.

<!-- session 0a4d8699 2026-08-31 -->
- Assumed MCP github-wadeck-app had write permissions; didn't verify read-only constraint before attempting push. User clarified: "le mcp server n'a pas de droit de push c'est volontaire, c'est un mcp read-only!!!!" — this is intentional design, not a config issue.
- Speculated about `GITHUB_MCP_TOKEN_WADECK_APP` token configuration without evidence when user had no idea what was being referenced. Violated CLAUDE.md rule: never invent facts, ask or investigate.
- Didn't know about ci-templates (`C:\Workspace_Tooling\ci-templates`) reusable workflow pattern. Wrote custom publish workflow that failed 3+ times, when `publish-npm.yml` existed.
- In spec mode: approved the spec unilaterally and exited mode. Should have kept it in review state — user must approve, not assistant.
- Jumped to technical architecture questions (ports, APIs, processes) without first establishing business requirements (monitoring vs config vs debug). User said: "tu ne poses pas de question business, ca m'inquiete... tu es parti direct en questions tehcniques!"
- Misunderstood user clarification "git add c'est ok" — repeated same explanation twice when user was confirming git add was needed (just not commit). User: "t'es dur de la feuille" (slow to understand).
- Claimed to test UI/endpoints without actually running them; detected only when user showed screenshots of errors.
- Initially treated daemon unavailability as 500 (internal error) instead of 503 (unavailable service); needed user-provided test case to prove the distinction.
- Copied dist files incorrectly (`cp -r src dest/` when dest exists creates `dest/src/src/`); learned to use `cp -rT` or `cp -r src/.` for clobber.
- ToolSearch called multiple times but returned "NOT YET KNOWN" for mcp__github-wadeck-app tools despite these being listed in deferred tools — query for push_files, get_file_contents failed to resolve (lines 20:03:33, 20:11:41, 20:19:26)
- User invoked `/kb` skill (line 20:25:48) and `/spec` skill (line 20:38:11) but both returned "NOT YET KNOWN" despite these being listed in available skills — skills failed to load/resolve
- Agent invoked `poll-ci` skill which returned "NOT YET KNOWN" (20:56:30), then fell back to manual sleep-based polling. Followed by 10+ sequential `sleep 5-60s && mcp__github-wadeck-app__actions_list` calls waiting for CI runs — suggests skill wasn't loaded in agent's context at invoke time, or skill definition was incomplete.
- Agent called ToolSearch to load `mcp__github-wadeck-app__actions_list` and related GitHub tools (20:56:34+), but tools remained marked "NOT YET KNOWN" even after search and were used anyway (20:56:38+). Schema loading from ToolSearch appears to have failed silently or schemas weren't applied to subsequent tool calls.
- Multiple MCP tool calls failed with "NOT YET KNOWN" (actions_list, get_job_logs) during CI status checks. Agent had poll-ci skill available but didn't use it, instead sleeping and retrying broken calls.
- tsconfig.json edits across packages required 3+ iterations (missing DOM lib, then fixes). Suggests incomplete initial scaffold or missing config template validation.
- vite-env.d.ts missing from initial orch-app Vite scaffold, added very late (21:58:17). Standard Vite projects require this file; should have been part of scaffold, not discovered during build.

## Documentation gaps

<!-- session 9bc60855 2026-09-05 -->
- Agent fork invoked `write-doc` skill which reported "NOT YET KNOWN" (07:40:12, 08:12:21) but recovered by using Write tool; suggests agent skill registry may not be current or skills not pre-loaded into fork context.
- entries.tsx generation pipeline not documented — cost ~10 grep/find iterations to discover it comes from @wadeck-app/dsl-renderer in capability-framework; no documentation on generator requirements for component Props naming (must be XxxProps, not Props)
- Feature rejections (e.g., DX-05 config-as-code) are marked in v3-todo.md with [!] but should be documented in `.claude/out-of-scope.md` or design docs to prevent future reintroduction attempts.
- DSL app pattern: data fetching belongs in YAML $sources, not component useState/useEffect. No linter rule existed; violations were discovered manually late in session.
- When to use deploy-dev.mjs vs npm install -g — sync path unclear; appears to be dev-only workaround that should be documented or formalized.
- $brains/$outputs/publishOutput callback pattern required extensive cross-project code exploration (dsl-renderer, capability-framework) — no DSL pattern reference for HTTP mutations documented in orchestrator.
- Registry override pattern (registry.ts → registry-overrides.ts → back to registry.ts) wasn't self-documenting; inconsistent file naming caused mid-task confusion about which file holds component mappings.

<!-- session 379d8f62 2026-09-02 -->
- Missing clarity on how @fastify/static plugin's wildcard option interacts with custom route registration in Fastify. Assistant repeatedly tried different route registration orders and hook combinations without reading the plugin's source first to understand the behavior.
- No guide on scraper environment configuration (.env.local files must be copied from workspace to ~/.config/scraper-name/.env.local); user discovered by accident after 30+ min of searching.
- Chrome profile location for chatgpt-scraper (.chrome-profile/ in data dir) undocumented; searching took 10+ min of file-system archaeology.
- DSL YAML component structure not immediately clear — agent fork explicitly spawned to read reference docs and examined multiple example YAML files across different projects (worker-detail.yaml, workers.yaml) to infer patterns

<!-- session a67e2f61 2026-09-01 -->
- Assistant used manual `sleep` commands for CI polling (15s, 30s, 60s, 90s waits) instead of the available `poll-ci` skill — no explicit guidance on when to delegate polling to the skill
- Agent reverse-engineered test setup (vitest.config, test-setup.ts, MSW setup) from capability-framework examples instead of local documentation (19:28:18 onward). Test infrastructure patterns not well-documented.
- Agent spent 18:43-18:46 investigating package linkage (tsconfig resolution, symlinks, dist availability) for @wadeck-app/dsl-renderer and @wadeck-app/dsl-ui. Type export mechanics and build integration not obvious from config.

<!-- session 508a6a16 2026-09-01 -->
- DSL approach and capability-framework testing pattern were not discoverable from current project alone — user had to reference `capability-framework` in another workspace; spec existed but wasn't checked first.
- `violations-suppress` comment placement requires trial-and-error: suppress covers only 1 line after, but violations on JSX blocks or spread over multiple lines need `suppress-start`/`suppress-end` syntax — rule not documented in violation rules.
- Capability-framework YAML/dsl-renderer pattern required extensive exploratory reads across two workspaces (capability-framework + dsl-view) with no documentation linking them; user had to request directory listings and multiple file reads to understand the pattern.
- Agent spent extended time (2026-09-01 18:20+) exploring multiple workspaces and DSL patterns (capability-framework) with extensive globbing/reading — suggests unclear requirements about feature scope or DSL renderer integration was not well-documented in the spec.
- DSL app architecture patterns (@registryCategory decorator, registry.ts structure, entries.tsx generation from dsl.config.yaml, Fetcher interface contract) required 20+ minutes of diagnostic exploration across node_modules and config files — should be templated or documented.
- Integration test setup for DSL apps (jsdom, msw, @testing-library/react, vitest config, test-setup.ts MSW server) had to be reverse-engineered from capability-framework examples; no pattern in this repo.

<!-- session 0a4d8699 2026-08-31 -->
- No project docs on MCP read-only design or ci-templates location. Both required user intervention to unblock.
- SDK wraps responses in `{ok: true, result: <data>}` envelope — not obvious from endpoint docs; required inspection of daemon-kit source.
- Config file persists after daemon stops — `config.port` left behind causes stale server attempts; dashboard should auto-start daemon on demand instead.
- ToolSearch workflow for deferred MCP tools is unclear — multiple attempts to search for tools returned NOT YET KNOWN despite tools being in deferred list; no clear guidance on when/how to load schemas for MCP tools

## Known constraints

<!-- session 9bc60855 2026-09-05 -->
- Launcher only checks `config.restart` sentinel if daemon exits with code 0. Exit code 1 (crash) skips restart logic — can leave daemon dead without relaunch.
- Auto-update check interval tuned to 30 minutes (user explicit requirement), not default 4 hours.
- Hidden process launcher pipes close silently on Windows (`SW_HIDE`): causes `console.log()` EPIPE crash, not obvious from error logs. The daemon itself was healthy; the launcher's hidden window pipe closure triggered the crash in child process stdout writes.
- GitHub Actions CI queuing: run #128 stuck in `in_progress` for 15+ minutes with frozen `updated_at` timestamp. Prior runs completed in 2–4 min. Polling did not detect actual completion state.
- @wadeck-app/dsl-renderer entriesGenerator.ts has implicit assumption that components export interface XxxProps (not interface Props); RouterProvider requires RouterProviderProps interface for generator to work; DataTableProps generic type causes render issues requiring post-generation patch script workaround
- pidusage library lacks TypeScript types; workaround is to create a manual `.d.ts` stub file in the package.
- violations-framework is a separate workspace; violations rule updates require switching projects and separate build/test cycles.
- pidusage module hoisting issue requires manual copy between nvm and workspace (xcopy/powershell). Windows-specific workaround fragility; deploy-dev.mjs masks the underlying setup problem.
- EPIPE errors from process.stderr.write() on subprocess output kills daemon silently on Windows; requires explicit error handling even when stream is closing normally.
- Browser/daemon asset sync requires ~40s sleep between deploy and screenshot; multiple retry loops (dsl-callbacks.png → dsl-final.png → dsl-final2.png → dsl-final3.png) suggest no robust "ready" detection for orchestrator asset propagation.

<!-- session 379d8f62 2026-09-02 -->
- Multi-tier deployment friction revealed: changes to orch-server dist files must sync to both local workspace and global npm install location (~/.nvm/v24.11.1/node_modules). This caused multiple rebuild→copy cycles to feel like "changes not taking effect" until both paths were synced.
- Tray manager spawns duplicate instances on restart (tracked multiple PIDs with taskkill loops) — root cause in _scheduleRestart logic required explicit test case to expose.
- Cross-workspace npm builds require explicit `npm install` before `npm run build` — dsl-view workspace node_modules were not cached/pre-installed (20:05)

<!-- session a67e2f61 2026-09-01 -->
- Dashboard binary deployment requires manual file copying (`cp -r` orch-server/dist → orchestrator-cli/server) and dependency injection (fastify added to package.json) — fragile artifact staging pattern that's not automated in build pipeline
- Deletion of old page files at 19:09:48 required special bypass script (request-bypass.js) instead of direct `rm`. Suggests overly restrictive delete permissions or unusual security setup worth documenting.

<!-- session 508a6a16 2026-09-01 -->
- Violations config: tags in `projectTags` auto-enable all rules with that tag. No manual `rules:{}` listing needed except for file-specific exclusions (`$exclude`) or inline suppressions. Agent tried to manually enumerate rules.
- Windows Git Bash environment: forward slashes in bash, backslashes in tool parameters, .exe binaries, no Python installed (user corrects when suggested), requires wscript.exe + VBScript for background processes.
- CI polling via MCP GitHub tools is unreliable — agent abandoned proper polling and fell back to hardcoded `sleep 10/15/30/60/90` waits throughout the session, consuming significant time waiting for builds.
- Windows file deletion requires special permission bypass via request-bypass.js script (node with --dangerouslyDisableSandbox); Bash rm alone was blocked and needed workaround at 19:09:48.
- violations skill invocation returned "NOT YET KNOWN" at 19:41:56; assistant recovered by calling bash directly, but suggests skill availability or registration issue for violations checker.
- npm test run took ~30 minutes (20:04:55 to 20:34:38) — test suite is slow; agent should have flagged this or run tests in background while fixing other violations.

<!-- session 0a4d8699 2026-08-31 -->
- npm workspace hoisting: packages resolve to workspace root, not `packages/*/node_modules/`. Build scripts and test paths must account for this or fail at runtime.
- Dist-tag mismatch: `compute-version` generates `latest` on push, not `edge`. Consuming packages must match. Not surfaced, caused npm install failure on CI.
- Guardrails blocks `Bash` with `&` + complex variable expansion; use separate simple commands or file-based args when hitting permission prompts.
- MCP tokens (`wadeck-app`, `wadeck`) lack write access to `wadeck-app/dsl-view` org repo — pushing to org repos requires additional credentials beyond default GitHub tokens
- Monorepo restructuring requires auditing CI/build scripts with relative paths — `copy-binaries.sh` needed path updates (`launcher-go/dist` → `packages/orchestrator-cli/launcher-go/dist`) after moving source into `packages/` directory structure
- GitHub Actions has measurable delay registering workflow runs after push — agent uses fixed sleep intervals (5s/8s/15s/20s/30s/60s) between status checks. Suggests need for exponential backoff or dedicated polling mechanism when poll-ci skill is unavailable.
