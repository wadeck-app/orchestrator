# Lessons Learned

Add entries with `/kb`. See `~/.claude/skills/kb/SKILL.md` for format.

---

### Lessons learned always go in the project, never in ~/.claude/kb

**Problem:** Attempted to write a lesson learned to the global `~/.claude/kb/lessons-learned.md` instead of the project-local `.claude/kb/lessons-learned.md`.
**Fix:** Always write to `<project>/.claude/kb/lessons-learned.md`. Never write to `~/.claude/kb/`.
**Context:** The global kb is not the target regardless of whether the lesson seems "general" -- the project kb is always the right location.

---

### Spec mode: never self-approve a spec

**Problem:** Marking a spec status as "Approved" without explicit user confirmation violates the spec protocol and removes the user's approval gate.
**Fix:** Keep status at "In Review" after all questions are resolved and wait for the user to explicitly approve before changing status to "Approved".
**Context:** The user is the sole authority on spec approval. "All questions resolved" means the spec is ready for review, not that it is approved.

---

### Always build and test locally before pushing to CI

**Problem:** Pushed code with TypeScript errors (missing DOM lib, wrong module setting, broken ESM spy) that only manifested in CI, causing many fix-push-poll cycles.
**Fix:** Run `npm run build --workspaces --if-present` and `npm test --workspaces --if-present` locally before any push.
**Context:** CI environment matches local exactly for TypeScript/Vitest errors. No excuse to skip this step.

---

### User expects full autonomy -- act and parallelize without asking

**Problem:** Repeatedly asked for confirmation before executing clear next steps, causing frustration.
**Fix:** After a decision is made, execute immediately. Launch parallel agents for independent workstreams in a single message. Only pause when a decision is genuinely open.
**Context:** User explicitly corrected multiple times ("autonomie!!!!", "en parallel quand possible"). Asking "should I proceed?" wastes time when the path is already decided.

---

### Update orch with `orch cli update`, never `npm install -g` by hand

**Problem:** A hand-rolled `npm install -g` leaves the CLI and the daemon on different versions when it half-applies, and skips the deferral that holds an update back while a job is running.
**Fix:** Run `orch cli update`.
**Context:** It restarts the daemon onto the new version for you (`config.restart` sentinel + `POST /quit`, `src/updater/entry.ts:151`) and defers while jobs are running unless `UPDATER_FORCE=1`. It does **not** protect against the Windows EBUSY below: `execNpm` runs the same `npm install -g <pkg>@<version>` with no extra flags, and the install happens *before* anything is stopped. An earlier version of this entry claimed the updater frees the file lock first -- it does not, and that claim was an inference made without reading the order of operations.

---

### Windows: `orch cli update` fails with EBUSY because the launcher-based update path is no longer used

**Problem:** Updating on Windows dies with `EBUSY ... orchestrator-cli-win32-x64/orchestrator.exe`, because `shared-updater`'s `without-daemon` strategy runs `npm install -g` in-process (`dist/strategies/without-daemon.js:71`) while `orchestrator.exe` (the resident Go launcher) and the `orchestrator-tray.exe` processes still hold files in the very directory npm has to replace; the `POST /quit` that would free them only happens afterwards (`:110`) and deliberately keeps the launcher alive.
**Fix:** Fixed in 45156bd by never executing a native binary from node_modules: the launcher and the tray are copied to `<configDir>/bin/<platform-package-version>/` and run from there, so nothing holds a file npm has to move. Publication, the exact-version pin and `require.resolve` are unchanged -- only the run location moved. `refreshStartupEntry` rewrites the login entry to the staged path on its own at daemon start.
**Context:** The Windows-safe path already exists and is configured but is never triggered. `launcher.go:245-262` → `:385` calls `spawnUpdateAndExit`, whose own comment is "Exiting releases the file lock on the running .exe so npm can overwrite it", and `ci/launcher.config.json` sets `updateCmd`. Nothing in `packages/orchestrator-cli/src` writes `config.update` (zero occurrences) -- only `config.restart`. It is a regression: `update-log.txt` still holds `Sentinel written — launcher will install ...` from 2026-08-30 and that string exists nowhere in the source today. Invisible on macOS/Linux, which have no mandatory file locking. Note the generated VBS runs `oShell.Run cmd, 0, False` and restarts nothing, so the sentinel path leaves the daemon down after installing.

**Addendum (intermittency, unresolved):** The same `orch cli update` that failed with EBUSY at 16:27 succeeded at 22:40 on the same machine with the launcher and both tray processes running throughout. `execNpm` is a plain `npm install -g`, so the command is not the variable. The failing operation was npm copying the running `orchestrator.exe` into its staging directory (`.orchestrator-cli-wnb1ETbR`) before replacing the parent package, so it turns on whether npm decides it must re-stage that nested directory -- not something to guess at. Whichever of the two fixes is chosen removes the dependence entirely, by not holding the lock while npm runs.

---

### Never delete package versions

**Problem:** A prune of "old" package versions once deleted every version of the packages.
**Fix:** Never run `npm unpublish` or `DELETE /.../packages/.../versions/...`. Produce a dry-run list of exactly what would be deleted and let the user execute it.
**Context:** Deletion is irreversible on GitHub Packages and a deleted version number cannot be republished.

---

### GitHub storage billing: accrued is not current

**Problem:** The org billing page still showed 0.5 GB used right after ~1.2 GB of private package versions had been deleted, which looks like the deletion did nothing.
**Fix:** Nothing to do -- deleting frees *current* storage but not the cycle's *accrued* total, so the figure only drops at the next billing cycle.
**Context:** Storage accrues hourly in GB-Hours, then `GB-Hours / hours_in_month = GB-Months`. Docs: "Storage already accrued during the current billing cycle remains in your total." The UI also lags 6-12 h. Retention changes are never retroactive either: existing artifacts keep the retention applied at creation.

---

### Only private repos and private packages draw on the Actions+Packages storage quota

**Problem:** `agent-fleet` (public) appears in the usage report with 266 GB-Hours of `actions_storage` and a non-zero `gross_amount`, which reads as quota consumption and led to a pointless proposal to remove its `upload-artifact` round-trip.
**Fix:** Ignore rows where `discount_amount == gross_amount` on a public repo -- Actions usage including storage is free for public repos, and public packages are free. Only private ones count. For wadeck-app the whole quota is the 7 private packages (`wdrive-cli` x4, 3 scrapers) = 0.183 GB.
**Context:** Audit recipe without the `gh` CLI (not installed): download the org usage report CSV (billing page -> "Get usage report") and group by `product`/`sku`/`repository`; `/repos/{org}/{repo}/actions/artifacts` and `/actions/cache/usage` are readable **unauthenticated** on public repos, while `/runs/{id}/logs` needs `actions:read`. Cross-check: summed private tarball sizes matched the `packages_storage` row exactly (0.1832 GiB), confirming compressed size and binary GB. Workflow logs and job summaries do not count. Cache is a separate 10 GB/repo allowance. `retention-days:` on an `upload-artifact` step overrides the org retention setting. Note `agent-fleet` workflows live on the `integration` branch, not `main`.

---

<!--
Entries below were merged in from the w-learning hook's `.claude/lessons-learned.md` (1052 lines,
227 session-tagged bullets) and `.claude/lessons-recommendations.md` on 2026-09-19, when the project
settled on a single lessons file. Session telemetry and observations about agent behaviour were
dropped; only durable technical lessons were kept, deduped against this file, CLAUDE.md and
`.claude/guiding-principles.md`. Every factual claim below was checked against the code, and three
claims in the source files were wrong and are corrected here: the timer slice is 86_400_000 ms and
not 60 s, the registry accepts five-field cron only rather than validating six, and the Go launcher
exit-code claim was dropped for lack of sources in this checkout.
-->

### Windows: suppress EPIPE on stdout/stderr at module level or the daemon dies silently

**Problem:** The hidden launcher window (`SW_HIDE`) closes the daemon's stdout/stderr pipes, so any later `console.log`/`process.stderr.write` throws an uncaught EPIPE and the daemon exits code 1 with no log entry.
**Fix:** Keep the global `process.stdout/stderr.on('error', ...)` EPIPE swallow near the top of `src/index.ts` and wrap every raw `process.stderr.write` in `try/catch`; never "fix" this per call site.
**Context:** A first pass patched only two `process.stderr.write` calls in `scheduler.ts` and declared victory -- the real crash came from a `console.log` in `index.ts`, so the daemon kept dying until suppression was moved to module level.

---

### Long waits must go through `waitUntil`, never a single `setTimeout`

**Problem:** A delay above `TIMER_CEILING_MS` (2^31-1 ms, ~24.85 days) is clamped to 1 ms by the runtime and fires immediately, so a far-future job runs at once.
**Fix:** Arm long deadlines with `waitUntil(time, deadlineMs, fn)` in `src/time-service.ts`, which slices at `MAX_TIMER_CHUNK_MS` (86_400_000 ms, one day) and re-derives the remaining time from the clock each slice.
**Context:** `FakeTime` deliberately reproduces the clamp so tests can fail on it. Slicing also absorbs NTP jumps and machine sleep -- only Linux `CLOCK_MONOTONIC` misses suspend; Windows `QueryPerformanceCounter` and macOS `mach_continuous_time` count it.

---

### Time-dependent scheduler code must take `TimeService`, not `setTimeout`/`setInterval`

**Problem:** Scheduler timing cannot be tested against real timers, so timing tests became flaky and were wrapped in shell retry loops instead of made deterministic.
**Fix:** Inject the time abstraction (`this._time.after` / `this._time.every`) in any new time-related feature and mock it in tests; fix a flaky timing test, never retry-loop or skip it.
**Context:** Converting `scheduler.ts` and `commands.ts` after the fact required touching every call site plus all test mocks -- plan the whole set up front when extracting timer logic.

---

### Cron schedules are five-field only; six fields silently mean something else

**Problem:** A six-field expression (with seconds) reinterprets every field -- "every second" becomes "every minute of hour 0" -- wrong and silent.
**Fix:** `scheduler.ts` rejects any `fieldCount !== 5` with an explicit error and does not fire the job; keep that guard and write schedules as `minute hour day month weekday`.
**Context:** `cronNext.ts` also parses only the first five fields, so a six-field job would preview one schedule and run another. The registry refuses them too, which is why liveness tests that armed a six-field cron were testing something no user can reach.

---

### Fastify v5 + `@fastify/static` loses routes registered as separate plugins

**Problem:** Registering the SSE `/api/events` route as its own plugin made it disappear at runtime; ~15 speculative edits went into route order, `hijack` vs `raw.writeHead`, and the static `wildcard` option before the interaction was identified.
**Fix:** Keep `/api/events` co-located in `routes/heartbeat.ts` rather than splitting it into a new plugin.
**Context:** The symptom is a 404 on a route the code clearly registers -- read the static plugin's behaviour before reordering registrations.

---

### Bind test servers to port 0, never a fixed port

**Problem:** Fixed ports in `orch-server` tests fail intermittently on Windows when the port is transiently held.
**Fix:** `await app.listen({ port: 0, host: '127.0.0.1' })` and read the assigned port back.
**Context:** Already the pattern in `routes/events.test.ts` and `logs-stream.test.ts`; regressions reintroduce hard-coded ports, and the 47950/47951 confusion cost repeated wrong-port curl rounds.

---

### `ORCH_CONFIG_DIR=$(mktemp -d /tmp/orch-*)` is not cross-platform

**Problem:** Integration tests build an isolated config dir from `/tmp`, which does not exist as expected on Windows and can fail quietly.
**Fix:** Use the OS temp dir via Node (`os.tmpdir()`) in a shared test helper and fail loudly if creation fails.
**Context:** The pattern is copy-pasted across many live-daemon tests (edit-unset, registry-normalize, skip-exit-codes, stale-run-sweep), so each new test repeats the hazard.

---

### Rule and UI test files require vitest -- `node --test --import tsx` passes without running them

**Problem:** Violations rule tests and `dsl-ui` tests exit green under `node --test --import tsx` without executing anything.
**Fix:** Run those suites with `vitest run` and write them with vitest's `describe/it/beforeAll/afterAll`.
**Context:** A silent pass is worse than a failure; it produced "tests pass" claims about suites that never ran. In this repo the CLI uses `node --test --require tsx/cjs` and orch-ui/orch-app/orch-server use vitest -- do not mix them.

---

### Violations: suppression syntax is per-rule, one line, and blocks need start/end

**Problem:** Suppression only covers the one following line, so JSX or multi-line violations stay unsuppressed -- and a suppression separated from its target by an intervening comment silently does nothing.
**Fix:** Put the suppress comment IMMEDIATELY above the offending line, and use `suppress-start` / `suppress-end` around multi-line or JSX violations. A comma-separated rule list on one line is supported: `violations-suppress: rule/one,rule/two <reason>`.
**Context:** The comma-separated form was previously recorded here as not working. It does -- proven by suppressing `cli/daemon-spawn-no-windows-hide,cli/no-spawn-without-windows-hide` on four sites and watching both rules stop firing, and the repo already used the form in `violations-suppress-start` blocks. The adjacency rule is the real trap, and it bit again in `tray-manager.ts`: a suppression sat above an explanatory comment rather than above the `execFile`, so the finding survived a decision that had already been made. Also note sibling rules: a spawn can be reported by two rules at once, and suppressing one leaves the other firing, which reads as an unaddressed finding. Run `violations check` with no grep filter as the final commit gate and compare totals before and after.

---

### `orch-app`'s `entries.tsx` is generated and depends on `XxxProps` naming

**Problem:** Component registry generation fails when a component exports `interface Props` instead of `interface XxxProps`; the error only surfaces as a late full-build type failure.
**Fix:** Name every component's props interface `<ComponentName>Props` and re-run `npm run build` to regenerate `entries.tsx` after component or dependency changes. Never hand-edit it.
**Context:** The generator lives in `@wadeck-app/dsl-renderer`; nothing in orch-app hints that the file is generated or that the naming is load-bearing.

---

### npm workspace resolution goes to the root `node_modules`

**Problem:** Build scripts and tests that assume `packages/*/node_modules/` resolve nothing at runtime, because npm hoists to the workspace root.
**Fix:** Resolve dependencies via `require.resolve` or root-relative paths; never hard-code a per-package `node_modules` path.
**Context:** The same class of bug as platform-binary resolution -- assuming a fixed layout under a hoisting package manager. Local tooling has the mirror hazard: `npx tsc` silently does nothing without a local install, so use `./node_modules/.bin/tsc`.

---

### Read `packages/*/src`, not `node_modules/@wadeck-app/*/dist`

**Problem:** Investigations repeatedly burned time reading compiled bundles (`shared-updater/dist/*.js`, `dsl-renderer/dist/*.js`) and drew conclusions from build output.
**Fix:** When delegating an investigation, name the source path explicitly; only open a dependency's `dist` when the question is genuinely about the published artefact.
**Context:** Two separate updater/launcher investigations chased EBADENGINE dead ends in `dist` while the actual defect was platform-package resolution in `src`.

---

### `config.port` and `config.dashboard` survive a daemon stop

**Problem:** Stale sentinel files make clients and the dashboard target a server that is gone, and a stale `config.dashboard` pins an old dashboard.
**Fix:** Treat the port and dashboard files as hints that must be validated -- probe or clear -- rather than as truth. `classifyDashboard` in `src/dashboard-pidfile.ts` exists for this; it is wired into `cli.ts`'s `server start/stop/status` only, not into the daemon's own startup, so a stale file self-heals on `orch server start` and not on `orch restart`. Forcing a dashboard refresh means writing `stale` into `config.dashboard` before restart.
**Context:** `<configDir>/config.port` is written on start and not removed on every exit path, so "server unreachable" after a stop is expected, not a bug.

---

### Publish dist-tag must match what consumers install

**Problem:** `compute-version` emitted the `latest` tag on push while a consuming package installed from `edge`, so CI installs failed with no obvious cause.
**Fix:** Assert at publish time that the computed dist-tag equals the tag consumers resolve, and fail the step loudly on mismatch.
**Context:** The mismatch is invisible locally and only shows up as an unresolvable version on another repo's CI.

---

### Visible terminal windows after `orch restart` are the job, not the daemon

**Problem:** Console windows popping up on restart were diagnosed as a daemon or launcher regression; the real cause was Chrome-based scraper jobs launched without the `windowsHidden` flag.
**Fix:** Check the job definitions for `windowsHidden` before touching launcher or tray code.
**Context:** orch takes the program at its word (P-8) -- a job's own spawn behaviour surfaces as apparent orchestrator misbehaviour.

---

### Scraper jobs need their env and Chrome profile in the config dir

**Problem:** Scraper jobs (whatsapp/chatgpt) failed with misleading dependency errors; over 30 minutes went into `supports-color` and module-copy theories.
**Fix:** Copy `.env.local` from the workspace into `~/.config/<scraper-name>/.env.local`; the Chrome profile lives in `.chrome-profile/` under the scraper's data dir.
**Context:** Missing env produces a failure that looks like a broken dependency, so the first hypothesis is always the wrong one.

---

### `bin/orch.js` must not special-case any command

**Problem:** The shim intercepted `start` and ran the windowsgui launcher through `execFileSync`, whose output goes to NUL -- `orch start` printed nothing and blocked for the daemon's whole lifetime, while `cli.ts`'s own detached `start` path was dead code.
**Fix:** Keep the shim a pass-through to the CLI bundle; daemon lifecycle decisions stay in TypeScript in `cli.ts`.
**Context:** Four earlier fixes targeted the wrong layer and produced the false lesson "MSYS2 Job Objects make fast detach impossible" -- measure which layer is waiting before theorising about the OS. The shim also re-spawns the bundle as a child, so its stdout is a real pipe: forcing `isTTY` in a parent process will not reach the human-readable render path.

---

### `pidtree` on a just-spawned pid can return processes that are not yours

**Problem:** A `killJob` test polled `pidtree(pid, {root: true})` as soon as the job's pid was recorded, then asserted every pid it returned was dead -- and reported nine survivors, one of which was a `node` process that had been running since the previous day.
**Fix:** Never let `pidtree` choose a test's assertion set. Have the fixture announce its own pid (`selfAnnouncing` in `exec-manager.test.js`) and assert on `[wrapperPid, announcedPid]`, a set the test fully controls.
**Context:** `pidtree` walks `ParentProcessId`, which is not unique over time on Windows: a freed pid still appears as the parent of unrelated live processes, so `pidtree` adopts an orphaned subtree. `process-tree-strangers.test.js` measured 29 dead pids named as a parent by a live process, one yielding 152 pids. `sampleProcessTree` guards the mirror image by rebuilding the tree link by link from `ppid` plus age. A fixed sleep does NOT fix this -- the strangers are not late, they are not ours -- and `exec-manager.test.js` already says why in one line: "waiting longer only widens the race."

---

### In a shared working tree, committing without a pathspec takes someone else's staged work

**Problem:** Two sessions shared one checkout. One had staged its files and was waiting on a permission dialog; the other committed with no pathspec, which took the whole index -- 12 of that commit's 14 files belonged to the other session and reached `main` under the wrong message.
**Fix:** Always name the paths explicitly on the commit, `-- <path> <path>`. Staging file by file is NOT the safeguard; the index is global.
**Context:** "I only staged my own files" gives a false sense of safety, because a commit with no pathspec ignores how carefully each index entry got there. Any pause between staging and committing -- a permission prompt, a test run, a question to the user -- is a window for another session's staging to land in your commit. Rewriting history is the wrong cure when both sessions are pushing to the same branch: leave it and add an empty commit documenting what the other half actually was.

---

### An unquoted `**` glob in an npm script silently runs a fraction of the suite

**Problem:** `"test": "node --test --require tsx/cjs test/**/*.test.js"` was unquoted, and `globstar` is off in this shell, so `**` degrades to `*`.
**Fix:** Quote the pattern -- `"test/**/*.test.js"` -- so Node's own globber expands it instead of the shell.
**Context:** It worked only because `test/` was flat: nothing matched, so the literal string reached Node, which does support `**`. Add one `test/<subdir>/` and on Linux and macOS (npm spawns `/bin/sh`) the shell expands it to that subdirectory alone -- `npm test` then runs one file and exits 0, green, while Windows (`cmd.exe`, no globbing) still runs all of them. A silently passing CI on two of three platforms, with no error anywhere. Proven here with `printf '%s\n' src/**/*.ts | wc -l` -> 4 against `ls src/*.ts | wc -l` -> 33.

---

### Use the `poll-ci` skill after every push -- hand-rolled sleep loops are a drift, not a shortcut

**Problem:** After the first push the skill was abandoned in favour of a `for i in $(seq 1 16); do sleep 25; ...` loop, for four consecutive pushes, and the user had to interrupt twice to stop it.
**Fix:** Invoke `/poll-ci <owner>/<repo> <sha>` after every push. No exceptions, including when a local script gives a more compact answer.
**Context:** The rule is already in `guiding-principles.md:47`. The pull towards the hand-rolled loop was that a custom timings script produced one tidy line per poll -- optimising for the agent's convenience over an explicit instruction. Compact output is not a reason to replace a skill; if a skill's output is too verbose, say so rather than silently dropping it.

---

### `typescript` 7.x exposes no JS compiler API -- codemods need a different parser

**Problem:** A codemod calling `ts.createSourceFile` threw `Cannot read properties of undefined (reading 'Latest')`; `require('typescript')` returns an object with exactly two keys, `version` and `versionMajorMinor`.
**Fix:** Use `@babel/parser` (present transitively via vite's react plugin) with `plugins: ['typescript']`, adding `'jsx'` only for `.tsx` -- in a `.ts` file `<Foo>bar` is a type assertion and the jsx plugin turns it into a parse error.
**Context:** This repo is on `typescript@7.0.2`, the native port, where the JS entry point is a version shim and the compiler is a Go binary. Anything that used to walk a TS AST from a script is broken by that upgrade. Leaning on a transitive dependency is acceptable for a one-off codemod and not for anything shipped or run in CI.

---

### The resource monitor mixes injected time with `Date.now()`, so `FakeTime` cannot drive it

**Problem:** `scheduler.ts` arms the sampling timer through `this._time.every` but reads the wall clock directly for the stall window (`samplingSince`, ~line 969) and the peak-flush throttle (`peakFlushedAt`, ~lines 926/930/983). Under `FakeTime` the ticks advance and those comparisons do not.
**Fix:** Until those reads go through `this._time.now()`, test the monitor with an injected `sampleUsage` plus a short real `sampleIntervalMs` -- not `FakeTime`.
**Context:** Found independently by two reviews. It is why the resource-budget tests use a real 25ms interval rather than stating elapsed time like `deadlines.test.js` does. Related trap in the same area: `samplingStallMs` is `sampleIntervalMs * 3` and the sampler must outlast the interval for an overlap test to mean anything, so the ratio is bounded below 3 by construction -- there is no "safe" constant. Assert that an overlap happened *before the stall window was due*, rather than that overlap never happened, or a merely busy runner fails the test for the host's reasons.

---

### Commit messages: subject, why, non-obvious constraint. Nothing else.

**Problem:** Five commits in a row shipped 10-25 line messages restating what the diff already says, after reading a plan whose own "Environment facts" said exactly this rule and warned that the long messages earlier in the history are not the model to copy.
**Fix:** Subject line, then two or three lines of *why*. Rationale that long belongs in a code comment next to the code it explains, or in this file - not in `git log`.
**Context:** Detail in a commit message is write-only: nobody greps `git log` for the reason a checkbox moved to the toolbar, they read the comment above it. Length also hides the one thing a message must carry, which is why the change was made at all. Applies to PR bodies too.

---

### A DSL `$output` override that injects unconditionally makes the component's own handler dead code

**Problem:** Bulk Enable/Disable/Run/Delete in the dashboard did nothing at all -- no confirmation, no request, no error. `registry-overrides.ts` injected all eight `JobCardGrid` callbacks whenever the node carried an `$id`, but `job-list.yaml` declares four outputs and has no bulk brains, so the clicks published into a namespace nothing read.
**Fix:** Inject only the event names the node declares under `$outputs`, so an undeclared one falls through to the component's own implementation. Guarded by `registry-overrides.test.tsx`.
**Context:** Every one of these components reads "the callback prop is defined" as "the page owns this action" and skips its own fetch. So injecting an undeclared callback does not add a behaviour, it removes one. `publishOutput` writes into a state bag and no brain subscribing is not an error, which is why this was silent. Corollary for layering: a confirmation is the component's concern and the mutation is the brain's -- ask *before* delegating, or the dialog is dead code on any page that owns the output.

---

### Clearing an in-flight marker in `.finally` lets an overtaken async walk disarm its successor's guard

**Problem:** The resource monitor's skip guard held only until the first stalled sample. `samplingSince` was cleared unconditionally when a walk settled, so the walk the stall escape had overtaken cleared the marker belonging to its still-outstanding successor -- and from then on every tick started another walk. Overlapping walks counted as consecutive `hardBreaches`, which kills a job early.
**Fix:** Tag each walk with an incrementing id and clear the marker only when `walk === currentWalk`.
**Context:** Surfaced as a Windows-only flake in "a sample is skipped while the previous one is still in flight", which only caught it when a runner happened to stretch a walk past the stall window on its own -- 10 green runs in a row, then red on an unrelated commit. Forcing the stall in the test makes the cascade deterministic on any host: 11 premature overlaps at ~62ms before the fix, none after. When an escape hatch is bounded by "one outstanding operation", the marker must identify *which* operation owns it; a bare timestamp cannot.
