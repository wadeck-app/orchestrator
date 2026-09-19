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

**Problem:** A single `violations-suppress shared/no-emoji,shared/no-unicode-symbol` line was assumed to work; it does not, and suppression only covers the one following line, so JSX or multi-line violations stay unsuppressed.
**Fix:** One suppress comment per rule, and `suppress-start` / `suppress-end` around multi-line or JSX violations.
**Context:** Run `violations check` with no grep filter as the final commit gate -- filtering with negative greps masked real violations and the filter list itself was wrong. Compare the total before and after a change to see what you actually added.

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
