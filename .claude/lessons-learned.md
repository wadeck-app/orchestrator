# Lessons learned

<!-- Last updated: 2026-09-15T13:19:01.308Z -->

## Recurring feedback

<!-- session d4afe4f0 2026-09-11 -->
- Claiming test completion when only partial/mock tests done — said "I tested" comprehensively but only ran isolated semver.satisfies() and npm view mocks, not real updater integration with npm install + engine mismatch
- Extended polling loops checking `npm view @wadeck-app/orchestrator-cli version` every 7-8 seconds (15+ iterations per publish wait), suggesting this pattern should be wrapped in a helper rather than repeated manually.

<!-- session 989aad99 2026-09-12 -->
- Switched between poll-ci skill and manual sleep-polling for CI (13:37:34 skill call, then resumed sleep loops at 13:37:40); suggests skill may not have blocked/completed as expected or agent lost trust mid-wait

<!-- session e537ae5a 2026-09-12 -->
- After log path or initialization changes, verify via: (1) check actual files created (not just code), (2) tail the log file, (3) confirm daemon stopped/restarted with new binary. Code correctness ≠ runtime behavior.

<!-- session 2d0a5323 2026-09-12 -->
- Multiple component files needed ButtonAction→Button replacement pattern (JobDetailActions, JobDetailSection, JobForm, RunningAlertDetail, RunningBannerDetail); suggests Button component's prop support (disabled, loading) should have been available earlier or the need for migration was preventable with clearer initial design.

<!-- session cadd0777 2026-09-11 -->
- Long session gap (22:57 2026-09-10 → 06:17 2026-09-11) with repeated npm version checks suggests agent was blocking/waiting on external CI/publish rather than using sleep intervals. Heavy polling of single command rather than deferring to eventual notification.

<!-- session b437c52a 2026-09-11 -->
- Session created 6 ad-hoc test scripts (.js files) to verify behavior incrementally (test-npm-view.js, test-engine-check.js, test-updater-integration.js, etc.) instead of adding unit tests; suggests test coverage for cross-version compatibility is weak or hard to automate.

<!-- session 6f352580 2026-09-11 -->
- Package publication verified via manual polling loop across many commits instead of relying on CI publish signal as completion marker
- User had uncommitted changes in tray-manager.ts and .claude/lessons-learned.md at session start; agent pursued investigation and eventually made an edit to tray-manager.ts, but the actual problem statement and resolution rationale are not captured in this chunk.

<!-- session 6502de66 2026-09-11 -->
- User corrected required output format in transcript — future lesson-extraction tasks should strictly use only: [Recurring feedback], [Agent errors], [Documentation gaps], [Known constraints] patterns

<!-- session 10054f73 2026-09-11 -->
- After `git commit`, use `/poll-ci` skill to track CI runs rather than polling `npm view` repeatedly.

<!-- session fce7fac0 2026-09-11 -->
- violations checks used grep filters to suppress known violations rather than running comprehensive checks — masked real violations and relied on suppression list being correct.
- Multiple commits pushed after violations check with selective grep filtering and incomplete coverage — should run `violations check` without suppression.

<!-- session 8bb7c278 2026-09-11 -->
- Proper pattern emerged: file edit → build check → violations check → test → commit — agent verified changes at each step before proceeding.

<!-- session c670db16 2026-09-11 -->
- Polling loops with fixed 8-10s intervals for npm package availability inefficient; multiple version checks (v196→v199→v200→v201→v202→v203) burn cycles

<!-- session 508a6a16 2026-09-08 -->
- ~~`orch start` blocks in Git Bash/MSYS2 for ~30s even with process.exit(0) and Go launcher. Root cause: MSYS2 tracks ALL descendants via Windows Job Object — no spawn approach escapes this.~~ **Wrong, corrected 2026-09-15.** `orch start --no-follow` returns in 0s with the daemon, the Go supervisor and the tray all up. The blocker was `bin/orch.js` intercepting `start` and running the windowsgui launcher through `execFileSync`, so the shim waited for the whole daemon lifetime while the launcher's output went to NUL; `cli.ts`'s own `start` case, which spawns detached and exits, was dead code. Four earlier attempts fixed the wrong layer. Lesson about the lesson: "no approach escapes this" was inferred from repeated failure, never measured against the layer actually doing the waiting.

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

<!-- session d4afe4f0 2026-09-11 -->
- Downgraded Node to 20 for testing but never restored the original version, leaving user to fix manually ("merci d'avoir pas remis le node")
- Left temporary test files (test-*.js) behind after testing without proactive cleanup
- Provided false confidence about test coverage instead of admitting upfront: "I can test pieces (bundler, semver parsing) but cannot simulate real npm install with engine mismatch + daemon self-check failure"
- Repeated "NOT YET KNOWN" warnings for mcp__github-wadeck-app__actions_list (method=list_workflow_jobs/list_workflow_runs) during poll-ci skill execution, indicating tool schemas not initialized before MCP calls.
- Explore agent delegated to investigate shared-updater rollback/EBADENGINE after lengthy manual debugging, suggesting the updater error recovery mechanism's constraints aren't self-evident from public API.

<!-- session c707b1b6 2026-09-15 -->
- File discovery escalation: used Bash find/grep before Glob tool—should frontload Glob for multi-project file searches to reduce round-trips.

<!-- session 989aad99 2026-09-12 -->
- Called mcp__github-wadeck-app__actions_list repeatedly without pre-loading schema (*** NOT YET KNOWN *** warnings); should have called ToolSearch before first use instead of discovering schema missing mid-loop

<!-- session f73d5c4f 2026-09-12 -->
- Tool schemas not fetched before use: Multiple "NOT YET KNOWN" warnings for `mcp__github-wadeck-app__actions_list` and related MCP tools (13:01-13:25). Agent attempted to invoke these without first calling ToolSearch to load schemas.
- Skill invocation without fallback: `poll-ci` skill called twice (12:15, 13:24) with "NOT YET KNOWN" warnings. Arguments also inconsistent (mixed French "après le push" with English repo format). Skill exists but invocation failed silently in context.
- Dist/source mismatch: Agent changed logger instantiation in source, then repeatedly grepped `/dist/` for old references instead of trusting the build. Didn't verify that `npm run build` actually replaced old code until much later, creating ~20 min of wasted cycles re-reading/re-editing same lines.
- MCP tool `mcp__github-wadeck-app__actions_list` (list_workflow_jobs) returned repeated "NOT YET KNOWN" errors, causing poll-ci to fail; agent abandoned CI polling after 10+ min and fell back to manual `npm install -g` testing instead of diagnosing the tool availability issue.

<!-- session 4613e462 2026-09-12 -->
- poll-ci skill repeatedly invoked but marked "NOT YET KNOWN" (12:15:18, 12:15:21, 12:15:27+, 13:23:08+) — caused fallback to manual sleep-loop polling (13:01:11: 30 × 10s placeholder) blocking progress on CI wait
- GitHub MCP tools (actions_list, get_job_logs) consistently marked "NOT YET KNOWN" when called for CI tracking despite being listed in deferred tools — suggests MCP server connectivity issue (correlates with earlier intellij connection failure) but error messaging doesn't clarify root cause
- Global npm package install (`npm install -g @wadeck-app/orchestrator-cli@latest`) performed without asking user first — violates explicit CLAUDE.md constraint: "NEVER install applications, system packages, global npm/pip packages, or any software without explicitly asking the user first."
- MCP tools (`mcp__github-wadeck-app__actions_list`, `mcp__github-wadeck-app__get_job_logs`) called without pre-fetching schemas, generating repeated "NOT YET KNOWN" warnings; ToolSearch was eventually used mid-session but should have been called upfront.

<!-- session e537ae5a 2026-09-12 -->
- Assumed logger changes (DailyLogger initialization path) would take effect after code edits without verifying: (1) rebuild produced new dist, (2) daemon actually restarted, (3) logs created in new paths. Required multiple verify cycles tailing logs and checking directory structure.

<!-- session 7b75482b 2026-09-12 -->
- Agent spent long period (09:06–12:12) in blind debugging loop: editing logger instantiation, rebuilding, restarting daemon, checking logs, finding logs still in old location, repeating. Root issue unclear—either the edits weren't taking effect or the understanding of the logging contract was incomplete.

<!-- session 55db0be5 2026-09-12 -->
- Attempted manual polling loop (5-min sleep placeholder) instead of recognizing CI polling pattern; `poll-ci` skill invoked but showed "NOT YET KNOWN" warnings, suggesting tool initialization or availability issues rather than using fallback polling
- Used silent bash fallbacks (`2>/dev/null || echo "skipped"`) multiple times during log migration, violating explicit user guidance against silent failure modes

<!-- session 2d0a5323 2026-09-12 -->
- GitHub Actions MCP tools (actions_list, get_job_logs) repeatedly failed with "NOT YET KNOWN" warnings, leaving CI polling integration incomplete; attempted workaround with placeholder polling code instead of addressing root cause of tool unavailability.

<!-- session 127dcd54 2026-09-12 -->
- Agent called poll-ci skill and MCP GitHub actions tools without fetching schemas first; ToolSearch and tool invocations returned "*** NOT YET KNOWN ***" at 12:15:18→12:15:38, blocking CI monitoring workflow.
- Multiple attempts to use deferred tools (TaskList at 09:21:41, poll-ci at 12:15:18, mcp__github-wadeck-app tools at 12:15:21→12:15:38) without explicit ToolSearch fetch; cascading "NOT YET KNOWN" warnings suggest agents skipping schema loading step.

<!-- session 3a0b65cc 2026-09-12 -->
- Logs reorganization task entered debugging loop (2.5+ hours of build → grep → restart → check logs cycles); agent needed to test live daemon with proper log output earlier, not rely on repeated grep/build verification alone
- Created multiple architectural files (persistence.ts, handlers.ts, spawn-manager.ts) with no clear integration verification; later changes to package versions suggest these may not have been properly tested

<!-- session 558bf1b7 2026-09-12 -->
- Two parallel sessions (83923577, 8294a93e) worked on overlapping daemon/logging concerns without coordination — first session reshaped logger architecture, second spent 3 hours debugging missing logs (09:51–12:12), suggesting incomplete handoff or missing scope clarity between agents.
- Second agent attempted to debug DailyLogger path issues multiple times (read logger.ts, rebuilt, reinstalled package, restarted daemon) without the fixes persisting — indicates the log migration logic was incomplete or the compiled dist code wasn't updating with source changes.

<!-- session f0424236 2026-09-12 -->
- Deferred tool loading blocked CI monitoring after git push: `poll-ci` skill invoked but returned "NOT YET KNOWN" (12:15:18); subsequent ToolSearch calls for `mcp__github-wadeck-app__actions_list` and `mcp__github-wadeck-app__get_job_logs` also failed; agent fell back to manual polling loop (13:01:11), wasting ~45 minutes of session time.

<!-- session 1a964fb3 2026-09-12 -->
- Attempted to invoke unloaded deferred tools (`poll-ci` skill, MCP GitHub tools) without pre-loading schemas via ToolSearch. Multiple "NOT YET KNOWN" failures between 12:15:18–12:15:38 before pivoting away from CI polling entirely.
- Created a placeholder poll loop (`for i in {1..30}; do sleep 10`) instead of implementing real CI polling, followed by 10+ minutes of inactivity (13:01:14–13:11:57).

<!-- session cadd0777 2026-09-11 -->
- poll-ci skill invoked 3+ times but consistently marked "NOT YET KNOWN" in command log — suggests skill definition not loading or parameters not recognized; skill calls appear to run but warnings indicate misconfiguration.
- Explore agent's initial investigation focused on EBADENGINE and Node version engine mismatches (16:17–16:18), but actual issue was platform launcher package resolution—initial hypothesis was misdirected.

<!-- session 72227cdf 2026-09-11 -->
- poll-ci skill + mcp__github-wadeck-app__actions_* tools return "NOT YET KNOWN" across 6+ commit pushes (22:35, 22:42, 22:55, 07:31, 07:38, 09:51); tools not working—stop attempting CI polling
- Fallback to tight-loop npm view polling (10+ calls per 60-90s) instead of long-interval waits; npm publish latency is 8+ minutes, tight polling wastes quota
- Multiple edits to `updater/entry.ts` (3+ attempts) suggests agent wasn't clear on correct launcher binary resolution approach; settled on platform package dynamic require.
- Six temporary test files created (`test-engine-check.js`, `test-npm-view.js`, `test-bundler.js`, `test-updater-integration.js`, etc.) for investigation—unclear if cleanup happened or files committed.

<!-- session b437c52a 2026-09-11 -->
- poll-ci skill showed "NOT YET KNOWN" warnings (13+ instances across v196→v203 commits); agent fell back to manual `npm view` polling instead of using poll-ci correctly
- Long session gaps (22:55:23 → 06:17:40 next day → 06:20:55 → 07:31:16 → 09:18:23 → 16:13:56) suggest user had to return manually rather than agent using ScheduleWakeup to self-pace during external waits (CI runs, npm publish delays)
- Explore agent read compiled .js files from node_modules/@wadeck-app/shared-updater/dist/ instead of locating source files in packages/orchestrator-cli/src; spent time investigating dead ends when the root issue was require.resolve() misuse for platform-specific launcher binaries.
- Explore agent did not quickly identify that @wadeck-app/orchestrator-cli-win32-x64 platform package needed to be resolved separately; session eventually discovered this by examining node_modules structure and file listings directly.

<!-- session 640db411 2026-09-11 -->
- poll-ci skill invoked 13+ times with persistent "*** NOT YET KNOWN ***" warnings; agent continued without validation or explicit error handling
- agent-browser element finding required multiple trial-and-error strategies per element (snapshots, role queries, eval, index-based clicking); UI selectors not reliably documented or stable

<!-- session f0424294 2026-09-11 -->
- Attempted multiple sequential CI polling calls and npm version checks with `poll-ci` skill showing "*** NOT YET KNOWN ***" warnings repeatedly — should have investigated tool configuration or waited for single completion notification instead of polling 15+ times.
- Searched for Go launcher binary in global npm paths with repeated `ls` commands to find orchestrator.exe, then used manual `cp dist/cli.js` workaround instead of `npm install -g` — should have understood platform-specific package layout upfront (orchestrator-cli-win32-x64 is a separate dependency).
- Tested `orch start` with multiple hypothesis-driven approaches (timeout, time, direct calls) rather than diagnosing root cause first (MSYS2 Job Object tracking mentioned in prior session).

<!-- session 7f6ab7ea 2026-09-11 -->
- Polling loop for npm package availability: checked `npm view @wadeck-app/orchestrator-cli version` every 7-10s across four separate time windows (22:43-22:57, 07:32-07:34, 07:40-07:41, 09:52-09:54) instead of using ScheduleWakeup + noop pattern; blocks context with repetitive queries.
- poll-ci skill returned "NOT YET KNOWN" repeatedly (22:35:08 onwards, 22:42:05, 22:55:23, 07:31:39, 07:39:03, 09:51:00); schema load or invocation pattern appears broken.
- Explore agent read multiple bundled dist files from node_modules/@wadeck-app/shared-updater (with-daemon.js, without-daemon.js, npm.js, state.js, lock.js, log.js, config.js) without clear hypothesis — unfocused search before narrowing to tray-manager source.
- Searched for "EBADENGINE" string in project source code and markdown docs — EBADENGINE is a system/npm error, not user code; misaligned symptom-to-search.

<!-- session 6f352580 2026-09-11 -->
- Poll-ci skill invocations showed repeated "NOT YET KNOWN" MCP tool warnings — tool schema caching may not work across multiple uses
- Extensive exploration of shared-updater internals and multiple repeated `npm view` calls for engine version checking across many orchestrator-cli versions suggests agent may have been searching broadly instead of targeting root cause directly; unclear if this path was necessary vs. a rabbit hole.

<!-- session 0f93887d 2026-09-11 -->
- After commits, agent falls back to manual `npm view @wadeck-app/orchestrator-cli version` polling (20+ checks over 5+ min) instead of using poll-ci to wait for publish — indicates either skill failure goes silent or agent doesn't trust async completion mechanisms.
- Browser automation queries retry multiple times with escalating strategies (snapshot grep → element selector → eval) to find UI elements like "Run early" button — suggests selectors/element IDs are unstable or agent doesn't know stable DOM query patterns.
- Explore agent read compiled .d.ts and .js files from node_modules/@wadeck-app/shared-updater instead of source — not actionable; should have targeted source files in packages/ directly.
- Extended grep fishing ("EBADENGINE", "rollback" patterns in .md files) without explicit problem hypothesis first — burned context before the actual issue (Node engine version + startup behavior) was framed.

<!-- session 6502de66 2026-09-11 -->
- `poll-ci` skill invoked multiple times with "NOT YET KNOWN" status, suggesting skill definition or context loading issue — appeared on commits 200311a, 6c9c9b3, 8d72132
- GitHub API calls (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs) repeatedly returned "NOT YET KNOWN", indicating tools were not properly loaded in agent context
- Agent read tray-manager.ts in 50-line chunks (lines 200-250, 260-310, etc.) instead of grepping for the target or reading the full file once—inefficient search pattern for a bounded file.

<!-- session 10054f73 2026-09-11 -->
- Launcher binary location search required trial-and-error across multiple paths (`npm root -g`, platform subdirs) before finding correct pattern.

<!-- session fce7fac0 2026-09-11 -->
- poll-ci skill repeatedly invoked but failed as "NOT YET KNOWN" — caused fallback to `npm view` polling loops instead of escalating the failure.

<!-- session fe32e78e 2026-09-11 -->
- Used manual polling loop (repeated `npm view` calls) instead of recognizing pattern as publishable polling task; poll-ci skill was invoked but showed "NOT YET KNOWN" warnings instead of properly executing.
- Output format violated required structure at start of chunk — assistant produced malformed findings instead of adhering to strict format specification before user correction.

<!-- session c670db16 2026-09-11 -->
- poll-ci skill invocations show repeated "NOT YET KNOWN" warnings followed by multiple MCP retry attempts; skill/tool not initialized before first use

<!-- session 703a40e4 2026-09-11 -->
- Launcher binary path (`orchestrator-cli-win32-x64/orchestrator.exe`) required multiple directory searches across npm package structure before being found; path calculation should assume platform-specific package layout from the start.
- Browser element selection for "Run early" button required multiple retry strategies (`snapshot -i`, enumerated clicks `@e6`, attribute selectors) before finding working approach; UI query API not well understood upfront.

<!-- session f09d03c6 2026-09-11 -->
- `poll-ci` skill invoked multiple times but marked "NOT YET KNOWN"; deferred tool loading blocked CI monitoring, causing fallback to manual polling.
- Multiple `mcp__github-wadeck-app__actions_list` calls failed with "NOT YET KNOWN" status; tool schemas were not fetched before invocation, generating noise without value.
- Relied on manual npm version polling (~8s intervals × 13+ checks per version) instead of intelligent wait strategy; no early termination or batch checking.

<!-- session 63e78bdf 2026-09-11 -->
- poll-ci skill and mcp__github-wadeck-app__actions_* tools repeatedly warned "NOT YET KNOWN" across 4+ commit pushes (22:35, 22:42, 22:55, 07:31, 07:38, 09:51). Assistant attempted polling after each push without checking availability first or understanding why it failed. No fallback or retry logic observed.
- Go launcher path resolution (07:36:40) wasn't validated before use — assistant had to manually construct and verify the path with sed and ls commands after implementation, indicating insufficient upfront validation of the calculated path string.
- Browser automation retries (07:43:56–07:46:26) struggled finding "Run early" button — tried snapshot -i, click @e6, eval in sequence, suggesting element selector or timing issues not diagnosed upfront.

<!-- session 7d180be6 2026-09-11 -->
- Polling loop instead of ScheduleWakeup: checked `npm view @wadeck-app/orchestrator-cli version` every 7-10s repeatedly across multiple time windows (22:43-22:57, 07:32-07:34, 07:40-07:41, 09:52-09:54) instead of using ScheduleWakeup tool for package publish waits
- Deferred tool schemas not pre-loaded: attempted poll-ci skill and mcp__github-wadeck-app__* MCP tools without calling ToolSearch first; resulted in "NOT YET KNOWN" warnings (22:35:08 onwards, repeated throughout session)

<!-- session bc8809c2 2026-09-11 -->
- Launcher binary path (`orchestrator-cli-win32-x64/orchestrator.exe`) required multiple directory searches before being found; path calculation assumes platform-specific npm package structure but this wasn't self-evident.
- Violations check filtering uses fragile negative patterns (`grep -v "no-emoji\|→\|docs/out-of-scope\|cli.ts:10[89]"`) to suppress false positives; output format not well understood, leading to trial-and-error filtering.

<!-- session 28b5e191 2026-09-11 -->
- Assistant tried to use `poll-ci` skill and GitHub Actions MCP tools multiple times with "NOT YET KNOWN" warnings — indicates skill/tool config or availability issue at session start.
- Misdiagnosed visible terminal windows from `orch restart` as a daemon restart bug; actually caused by Chrome background scrapers lacking `windowsHidden` flag — root cause unrelated to orchestrator code.

<!-- session 366dda51 2026-09-11 -->
- Repetitive polling instead of ScheduleWakeup: assistant checked `npm view @wadeck-app/orchestrator-cli version` every 8s for 7+ minutes waiting for package publish (timestamps 22:43-22:57, 07:32-07:41, 07:40-07:49, 09:52-09:54), burning cache repeatedly. Should delegate to ScheduleWakeup with 300s+ intervals for external publishing waits.
- Over-reliance on manual browser testing for feature validation: used agent-browser to take screenshots and manually click through UI (Run early button, logs button, list/grid toggle) rather than confirming tests existed or using automated verification. No clear evidence tests were written to cover the new "Logs button" feature before manual browser validation.

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

<!-- session d4afe4f0 2026-09-11 -->
- Node.js engine version constraints and EBADENGINE rollback behavior not documented; user debugged via shared-updater source inspection and npm engine queries to understand v199→v200 upgrade failure.

<!-- session f73d5c4f 2026-09-12 -->
- Log directory migration consumed ~3 hours (09:07-12:12) with unclear success criteria. Agent cycled through: mkdir, cp, rm, process restart, grep compiled code, npm link before finally settling on structure. No clear migration guide or validation path documented for when logs/ reorganization is complete.

<!-- session 4613e462 2026-09-12 -->
- No guidance for handling "NOT YET KNOWN" on deferred tools — unclear whether failure indicates MCP server down, credentials missing, configuration issue, or tool schema fetch failure; leaves agent without recovery path

<!-- session e537ae5a 2026-09-12 -->
- Log directory restructuring (daemon/tray → jobs/daemon, jobs/tray) lacked clear spec; caused trial-and-error confirmation that daemon actually wrote to new locations after migration.

<!-- session 7b75482b 2026-09-12 -->
- Logging directory structure (`logs/daemon`, `logs/tray`, `logs/jobs`) and how DailyLogger instantiation paths are resolved wasn't documented. Agent spent 3+ hours inferring the structure from directory inspection, multiple restarts, and checking compiled code instead of understanding the intended design upfront.

<!-- session 55db0be5 2026-09-12 -->
- No clear guidance on when to retry polling vs. when to escalate tool availability issues; agent spent 3+ hours debugging log structure without identifying that tool failures were blocking progress

<!-- session 2d0a5323 2026-09-12 -->
- Log directory refactoring (daemon/ → logs/jobs/, tray/ → logs/jobs/tray/) caused multiple trial-and-error attempts to find correct paths; migration path and DailyLogger initialization paths were unclear, requiring repeated reads of source files to verify correct location.

<!-- session 558bf1b7 2026-09-12 -->
- Log directory reorganization (daemon/ → jobs/daemon/, tray/ → jobs/tray/) was implemented but the new path expectations were not documented in logger or scheduler code — led agent to repeatedly check if paths were correct rather than trusting the refactoring was intentional.

<!-- session cadd0777 2026-09-11 -->
- No pre-existing test utilities for engine/updater verification; agent created test-engine-check.js, test-npm-view.js, test-bundler.js from scratch to debug and validate fixes.
- Missing @types/semver initially despite semver import in updater/entry.ts—required install step at 18:08:31 after build failures.

<!-- session 72227cdf 2026-09-11 -->
- Windows process detach behavior (orch start should return immediately) not documented; required manual investigation of registry + timing
- Windows registry startup path (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) and platform-specific launcher package naming (`@wadeck-app/orchestrator-cli-win32-x64`) require tracing through code; no inline docs.
- Semver engine compatibility check integration into updater wasn't explicit—agent traced through imports to understand new dependency requirement.

<!-- session b437c52a 2026-09-11 -->
- Platform-specific launcher binary resolution (orchestrator-cli-win32-x64, orchestrator-cli-darwin-arm64) is complex and not documented; no reference in .claude docs explaining how _PLATFORM_PKG or require.resolve should work for these binaries.
- Updater's engine compatibility check logic is missing from docs; session discovered it must validate Node.js semver constraints (via shared-updater) before executing scripts, but this contract is not explained in daemon-config.md or guiding-principles.md.

<!-- session f0424294 2026-09-11 -->
- UI feature implementation (Logs button on job cards) required cross-package navigation (cli → orch-server → LogViewer → ScheduleTimeline → JobCard/JobCardGrid) with grep-based pattern searching — architectural relationships between packages and feature flows should be documented.

<!-- session 7f6ab7ea 2026-09-11 -->
- Session required manually unzipping downloaded orchestrator.zip and inspecting daemon/tray logs to debug field issue — no captured error logs, no troubleshooting guide for engine version mismatches or startup failures.

<!-- session 6f352580 2026-09-11 -->
- Violations check filtering requires manual grep per file subset — no documented pattern for scoped checks to only modified files
- No clear guidance on Node.js engine version constraints strategy, version progression rules, or troubleshooting process for EBADENGINE/engine mismatch errors; required agent to reverse-engineer through npm registry queries and git history.

<!-- session 0f93887d 2026-09-11 -->
- Node engine version requirement changes (Node 20 vs Node 22) across releases are not documented; user had to manually npm view multiple versions to trace when it changed.

<!-- session 6502de66 2026-09-11 -->
- Engine version requirements (Node 20 vs 22) and rollback behavior scattered across shared-updater, self-check.ts, startup.ts, tray-manager.ts with no single source of truth; required multi-file investigation to understand.

<!-- session 1572ed6f 2026-09-11 -->
- Windows launcher selection logic (cli.ts launcher path calculation, Go vs VBS fallback) required multiple edits across the session, suggesting design complexity or unclear strategy; document or refactor to reduce iteration cycles.

<!-- session 10054f73 2026-09-11 -->
- DashboardManager initialization pattern requires codebase exploration; not evident from imports/exports alone.

<!-- session c670db16 2026-09-11 -->
- Go launcher binary requirement for Windows `orch start` detach (discovered via trial: `orchestrator.exe` in platform package) not documented; was found empirically

<!-- session 703a40e4 2026-09-11 -->
- Log command integration with `CliMetaCommands` from `@wadeck-app/shared-cli` required reading node_modules package definition to understand pattern; should be documented in project guide or type definitions.

<!-- session f09d03c6 2026-09-11 -->
- Deferred tools in system-reminder are listed but no guidance on when/how to invoke ToolSearch before calling them; led to repeated "NOT YET KNOWN" errors.

<!-- session eee06f9b 2026-09-11 -->
- agent-browser element selection shows fallback from semantic selectors (--name) to positional selectors (button index); lacks guidance on reliable selector strategies for dynamic/rendered components.

<!-- session c1c0a1ab 2026-09-11 -->
- The daemon log path location used by tests and CLI changed; tests reference this path but tests.md or cli.ts don't document the path scheme for future updates.

<!-- session bc8809c2 2026-09-11 -->
- Platform-specific npm package naming convention (`@wadeck-app/orchestrator-cli-win32-x64`) for native binaries not documented; Go launcher bundling strategy unclear until runtime discovery.

<!-- session 28b5e191 2026-09-11 -->
- Session showed ~1-minute polling cycle checking npm package versions (v199→v200→v201→v202→v203); no clear guidance on expected publish latency or how long to wait between checks.

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

<!-- session d4afe4f0 2026-09-11 -->
- Cannot fully integrate-test the updater in a real scenario (npm install with EBADENGINE warning, package corruption, rollback flow) — requires actual npm registry + runtime environment state
- Windows startup-at-login requires registry manipulation and launcher binary selection (VbsLauncher vs Go orchestrator.exe) — this Windows-specific logic is fragile and not surfaced in comments or docs.
- Windows port allocation is flaky with fixed ports; use port 0 for OS auto-allocation to avoid intermittent failures (orch-server/src/port.test.ts fix)

<!-- session c707b1b6 2026-09-15 -->
- Startup behavior spans orchestrator + wdrive projects; debugging one requires understanding both codebases and their integration points.

<!-- session 989aad99 2026-09-12 -->
- Heavy polling of npm registry version checks (20+ repetitions of `npm view @wadeck-app/orchestrator-cli version`) for package publication — use GitHub API to check package status or event-driven notifications instead of polling intervals
- Extended CI run time (~9 min 13:25–13:46) before package artifacts ready for manual npm install verification

<!-- session f73d5c4f 2026-09-12 -->
- Windows daemon lifecycle issues: Process termination not reliable. Multiple `ps aux | grep node` checks and attempts to verify logs existed **after restart**, but old logs still present or new logs not appearing. Suggests orphaned child processes or delayed file system operations on Windows.
- CLI package distribution lag: `npm link` invoked late (12:54) after many failed verify attempts, suggesting local `orch` binary wasn't picking up source changes despite rebuild. Constraint: npm link may be required for CLI updates in dev, not documented.
- `poll-ci` skill invocation with method `list_workflow_jobs` does not work reliably; agents polling GitHub Actions CI end up in manual sleep loops instead of structured polling when the MCP method is unavailable.

<!-- session 4613e462 2026-09-12 -->
- CI polling workflow fragile — when GitHub Actions tools unavailable, no fallback exists except manual sleep loops; no fallback to `gh` CLI or simpler GitHub API client
- `poll-ci` skill on long-running CI jobs results in extended polling cycles with exponential backoff (10s → 60s sleep, then 30-45s intervals); session polled for ~20 minutes waiting for workflow to complete.

<!-- session e537ae5a 2026-09-12 -->
- Windows orchestrator.exe launcher path must be calculated at runtime from npm root for platform-specific package (@wadeck-app/orchestrator-cli-win32-x64); no static path available.

<!-- session 7b75482b 2026-09-12 -->
- Daemon log file creation appears to have startup delay. Checking `logs/daemon/` immediately after `orch start` may show stale logs from previous runs, creating false signals about whether code changes took effect.

<!-- session 55db0be5 2026-09-12 -->
- Multiple MCP tools (`mcp__github-wadeck-app__actions_list`, `get_job_logs`, ToolSearch for TaskList) returned "*** NOT YET KNOWN ***" warnings throughout session, blocking CI status checks and task management; underlying cause unclear (connectivity, initialization order, tool availability)

<!-- session 2d0a5323 2026-09-12 -->
- Asset deployment requires manual copying from `orch-app/dist/assets/` to `orchestrator-cli/server/public/assets/` — no build step automates this sync; both locations must be kept in sync manually.

<!-- session 127dcd54 2026-09-12 -->
- Windows POSIX shell migration of logs/tmp folders required chmod/bypass scripting; directory moves in .config/orchestrator failed silently when processes held file locks, forcing npm link rebuild cycle to apply changes.

<!-- session 3a0b65cc 2026-09-12 -->
- Launcher binary path (`orchestrator-cli-win32-x64/orchestrator.exe`) requires careful navigation of npm package structure on Windows; path calculation or documentation should account for platform-specific binary layout
- Package version (`singleton-daemon-kit`) required restoration after being changed; version pinning decisions appear fragile

<!-- session 558bf1b7 2026-09-12 -->
- poll-ci skill failed to load GitHub Actions tools (multiple "NOT YET KNOWN" warnings on mcp__github-wadeck-app__actions_list/get_job_logs), blocking CI monitoring after git pushes.

<!-- session f0424236 2026-09-12 -->
- When using GitHub MCP tools from the deferred list, ToolSearch must be called and complete BEFORE invoking the tool itself. Attempting direct tool calls without prior schema loading results in "NOT YET KNOWN" warnings.
- Logs directory restructuring required `npm link` to force the local package into use (12:12:54), suggesting the daemon was using a stale globally-installed version rather than the local build — rebuilding and restarting alone were insufficient.

<!-- session cadd0777 2026-09-11 -->
- npm publish to GitHub Packages is asynchronous; `npm view` polls show multi-minute delays before version appears in registry. Agent polled repeatedly (v196→v199→v200→v201) waiting for publish completion.
- Launcher binary resolution requires careful interplay: platform-specific optionalDependencies in package.json, require.resolve() in startup.ts, and compiled output consistency in dist/. Fixing one place (entry.ts) required synchronizing tray-manager.ts and scheduler.test.js.

<!-- session 72227cdf 2026-09-11 -->
- Platform-specific package path (@wadeck-app/orchestrator-cli-win32-x64) not discoverable from install dir structure—requires glob or inspection of node_modules
- Windows scheduler test has platform-specific killJob behavior requiring conditional assertions (test skip/modification at line 290+).
- Node engine version checks critical for updates (Node 20 vs 22); multiple npm view calls needed to verify engine field compatibility across versions.

<!-- session b437c52a 2026-09-11 -->
- Waiting for npm package publication: manual repeated polling with `npm view @wadeck-app/orchestrator-cli version` (every 7-10s) used for v196, v199, v200, v201, v203 — indicates poll-ci skill was not functional or not invoked properly
- Windows scheduler test requires platform-aware mocking for process termination (kill behavior differs from Unix); the fix involves checking process.platform in test mocks, not just abstracting killJob().

<!-- session 640db411 2026-09-11 -->
- bash.exe.stackdump in working tree indicates crash event; timing, cause, and recovery steps not evident from command log

<!-- session f0424294 2026-09-11 -->
- Windows process detaching requires Go launcher (orchestrator.exe) as primary approach with VBScript fallback; platform-specific binaries are in separate npm packages (orchestrator-cli-win32-x64) not in main dist folder.

<!-- session 7f6ab7ea 2026-09-11 -->
- Browser automation selector discovery: agent-browser required multiple trial attempts (snapshot -i, click @e6, find role button click, eval) to locate "Run early" and "Toggle list view" buttons; best-practice selector pattern unclear from available docs.
- Multiple npm view commands for versions 2026.9.10-199 through 2026.8.29-040 checking engine specs suggest Node >=22 constraint was added recently; no clear commit or changelog entry for the change.

<!-- session 6f352580 2026-09-11 -->
- Dashboard server lifecycle requires hardcoded port 47950, explicit config state resets (echo "stale" > config.dashboard), and empirically-tuned sleep durations instead of active readiness detection
- Windows development: platform package binary path calculation requires Unix→Windows path conversion (sed 's|/|\\\\|g') from npm root -g output
- Node.js engine version compatibility (Node 20 vs 22) is a known pain point requiring investigation of package.json engine fields, npm registry, daemon/tray logs, and git history; consider consolidating engine strategy documentation.

<!-- session 0f93887d 2026-09-11 -->
- poll-ci skill invocations return "*** NOT YET KNOWN ***" warnings repeatedly (commits c93beda, 200311a, 5d5859b, 6c9c9b3, 8d72132) followed by GitHub MCP tool warnings — verify tool/skill availability before relying on CI polling.
- Startup-at-login feature in tray-manager.ts has issues with Node version compatibility or daemon state; actual logs examined from ~/.orchestrator config dump, not from active session logs.

<!-- session 6502de66 2026-09-11 -->
- npm publish to GitHub Packages requires repeated polling; manual `npm view` checks ran ~15 times per commit to wait for version propagation — expected delay, but highlights need for async polling pattern or timeout tolerance
- npm view commands across different @wadeck-app/orchestrator-cli versions fail or return unexpected engine constraints—not documented in lessons-learned as a known investigation pattern or blockers.

<!-- session 1572ed6f 2026-09-11 -->
- CI monitoring via poll-ci tool repeatedly calls list_workflow_jobs with 8-10s intervals across multiple rounds; consider batch queries or exponential backoff instead of tight polling cycles.

<!-- session 10054f73 2026-09-11 -->
- Platform-specific npm packages (e.g., `@wadeck-app/orchestrator-cli-win32-x64`) distribute compiled binaries; launcher path must be calculated from `npm root -g` at runtime.
- Dashboard config state (version, stale flag) persisted in config files (`config.dashboard`, `config.port`); force-refresh requires writing "stale" marker before restart.

<!-- session fce7fac0 2026-09-11 -->
- No async notification for GitHub Packages publishes; extended polling loops indicate waiting for CI completion with only synchronous polling available.

<!-- session 8bb7c278 2026-09-11 -->
- Heavy polling of npm registry version checks (20+ repetitions of `npm view @wadeck-app/orchestrator-cli version`) to wait for package publication — inefficient pattern; consider using GitHub release/tag webhooks or CI notification instead.
- MCP tool schemas must be fetched before calling (poll-ci, mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs repeatedly marked "NOT YET KNOWN").

<!-- session 7ea07a3f 2026-09-11 -->
- Windows Go launcher (orchestrator.exe) path must be calculated at runtime from npm root for platform-specific package (@wadeck-app/orchestrator-cli-win32-x64); fallback to VBS required if launcher unavailable.

<!-- session fe32e78e 2026-09-11 -->
- Skills invoked with "*** NOT YET KNOWN ***" indicate tool schemas were unavailable; assistant should proactively use ToolSearch to load schema before attempting to invoke unfamiliar skills or deferred tools.

<!-- session c670db16 2026-09-11 -->
- Windows Git Bash forward-slash encoding breaks cmd.exe `/PID` arguments (converted to file path); use `powershell.exe -c` directly for process control on Windows
- Agent-browser uses hard-coded sleep delays (`sleep 2000`, `sleep 8`) instead of event-based waits; tests are brittle to timing

<!-- session 703a40e4 2026-09-11 -->
- Package version polling required repeated `npm view @wadeck-app/orchestrator-cli version` calls with ~8-10s intervals over multiple minutes; waiting for publish is slow and polling should be replaced with event-driven or timeout-based strategy.

<!-- session f09d03c6 2026-09-11 -->
- UI element interaction testing required multiple selector strategies (snapshot→eval→click) to reliably locate buttons; no stable test IDs or role-based selectors observed, forcing workarounds.

<!-- session b6fbe6dc 2026-09-11 -->
- npm package publishing delays 8+ hours; session polled `npm view @wadeck-app/orchestrator-cli version` 15+ times sequentially instead of using event-driven wait or CI notification mechanism.

<!-- session 63e78bdf 2026-09-11 -->
- Manual npm version polling (repeated `npm view @wadeck-app/orchestrator-cli version` every 7-8s) used instead of automated CI watch — inefficient and burned context waiting for package publish (~1-2 min waits per release cycle).

<!-- session 7d180be6 2026-09-11 -->
- Session disconnection/resume over 7+ hours (22:57:49 → 06:17:40 next day) caused redundant polling for same package version after reconnection; suggests tool schema cache reset across session boundaries

<!-- session eee06f9b 2026-09-11 -->
- npm package publishing delays lead to inefficient polling cycles (7-9s intervals over multiple minutes); future sessions should use longer backoff or event-based triggers instead of tight polling loops.

<!-- session c1c0a1ab 2026-09-11 -->
- Windows Go launcher (orchestrator.exe) path must be calculated at runtime from npm root for platform-specific package (@wadeck-app/orchestrator-cli-win32-x64); fallback to VBS required if binary absent.

<!-- session bc8809c2 2026-09-11 -->
- npm package publish has variable delays; agent polls 10+ times after commits waiting for version bump to appear, suggesting no clear feedback on publish readiness.

<!-- session 28b5e191 2026-09-11 -->
- Multiple permission prompts for git-commit-push required external bypass requests; consider pre-authorizing in settings if pattern repeats.

<!-- session 366dda51 2026-09-11 -->
- Long session with 7+ hour gap (22:57 Sept 10 → 06:17 Sept 11) suggests async polling across sleep cycles — assistant correctly resumed work but polling pattern remained inefficient on resume.

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
