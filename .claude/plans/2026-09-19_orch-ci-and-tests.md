# CI speed and test discipline — continuation plan

Written for a fresh context. Facts here were measured, not estimated; numbers come from CI runs
`35430352921` (before), `35433465296` (after caching) and local timings on the user's machine.

Companion plan from another session: `.claude/plans/2026-09-18_orch-remaining-work.md` (active window
UI, past `once` jobs, dsl-view). Do not duplicate it.

## Decisions already taken by the user — do not re-litigate

- **No caches in private repos.** Free mode is to be preserved there. The caching in this workflow is
  acceptable only because this repo is public. Never carry the pattern into a private repo.
- **Never mention private repos, their names or their billing in this repo.** It is public.
- **No branches** unless explicitly asked. Commit straight to `main`.
- **No real-time in tests.** Everything must be controlled.
- **Test scope rule: platform by default, ubuntu-only on an explicit decision.** A new test file is
  covered on all three runners until someone deliberately marks it otherwise. Never the reverse.
- **`poll-ci` after every push.** No manual `sleep` loops.
- **Comments: concise.** No wall of text.

## Where the time goes now — 5m07 total

Windows is the critical path at 252s; `publish` adds 55s in series.

| Step (Windows) | Time | Note |
|---|---|---|
| Run tests | 115s | 46%, and growing: 84s before ~90 tests landed today |
| Build orch-app (SPA) | 57s | should be ~0 from the next run — cache landed in `d897203` |
| Install dependencies | 22s | npm cache gives back only 7s; cost is writing files |
| checkout + setup-node + setup-go | 28s | floor |
| Go builds, bundles, tsc | 22s | was 90s before the Go cache |

## Remaining work, in impact order

### 1. Verify the SPA cache actually hits — first thing to do

`d897203` added `actions/cache` on `packages/orch-app/dist`, keyed on the lockfile plus orch-app and
orch-ui sources, with no `runner.os` so one build serves all three runners. That run populated it, so
the next run is the first that can hit. Check `Build orch-app` is skipped and `Typecheck orch-app`
runs instead. Expected: Windows 252s -> ~195s, total ~4m10.

If it misses every time, the key includes something that changes per run — suspect
`packages/orch-app/src/generated/entries.tsx`, which `patch-entries.mjs` rewrites during the build.

### 2. Test categorisation — the only lever that holds over time

`npm test` in orchestrator-cli is one flat glob: `node --test --require tsx/cjs test/**/*.test.js`.
Nothing is categorised. 8 of ~30 files reference platform specifics (`staged-binary`, `scheduler`,
`config-dir`, `platform-binary`, `startup`, `secrets`, `smoke`, `cli.integration`); `process-tree` is
almost certainly a ninth (taskkill vs pkill) and was missed because the grep pattern was blocked.

Mechanism to build, respecting the user's rule:
- An in-file marker, e.g. `// @test-scope ubuntu-only -- <reason>`, so the decision sits next to the
  test and absence of a marker means "runs everywhere".
- A small runner (`scripts/run-tests.mjs`) that collects files and drops the marked ones when asked.
  `npm test` with no flag keeps running everything, so local behaviour is unchanged.
- Windows and macOS legs pass the flag; ubuntu runs everything.

Expected: Windows tests 115s -> ~30s.

**Classification is the risky part.** Marking a file ubuntu-only removes its Windows coverage, which
is the exact failure the 3-OS matrix was added to prevent (regressions shipped 2026-09-15). Classify
file by file, default to platform, and do not batch it.

### 3. Remove real-time from the tests — the user's requirement

`FakeTime` already exists (`src/time-service.ts`, built by the other session). Still sleeping:
`job-peaks` allows itself 20s, several scheduler tests sleep, the resource-monitor tests sleep.

Two tests must keep the real clock — `systemTime is the real clock` in `time-service.test.js` — since
they verify the adapter itself. They already wait for a condition rather than a wall-clock window,
which is what fixed the red main on `6fbf87a`.

### 4. `publish` reuses the matrix output — now worth less

Was ~85s of rebuild; the Go and SPA caches already cut `publish` to 55s, so the remaining gain is
~40s. Needs `upload-artifact` with `retention-days: 1` and minimal contents (dist dirs and binaries,
never `node_modules`). Take the binaries from ubuntu so their provenance does not change.

### 5. Open, lower priority

- **Stale `config.dashboard`**: points at dead pid 77244 on port 47951 since 2026-09-18T20:37 and was
  never cleaned, though `classifyDashboard` exists in `dashboard-pidfile.ts`. Handed over by the other
  session, not investigated. Note a dev server may be squatting that port; `node scripts/dev-server.mjs
  --stop` frees it.
- **`bash.exe.stackdump` is tracked** and shows up dirty in `git status`. Junk, probably should be
  removed from the index and gitignored. Not mine, not touched.
- **Cross-host binary determinism is unproven.** Three builds on one host matched byte for byte,
  including one with a cold `GOCACHE`; the only cross-host comparison available differed because the
  toolchains differed (`go1.26.5` locally vs `go1.26.8` for the published binary, read with
  `go version <exe>`). Matters only if per-OS binary builds are ever adopted — the Go patch is now
  pinned, which is the prerequisite.
- **`orch trigger --wait` prints `exit ?`** in some paths: fixed for the daemon side, but the CLI's
  message when the daemon answers `{pid}` was not revisited.

## Landed this session, for context

- `orch edit --unset <field>`, and empty values dropped at the single write choke point in
  `registry._write`.
- `--skip-exit-codes`: a declared exit code is a skip, excluded from failures, the consecutive-failure
  alert, retries, dependents, the systray, the failure list and uptime. The user's three scrapers are
  configured with `2`; `post-process-10h` deliberately is not, because it chains two commands with
  `&&` and an exit 2 there means the second never ran.
- Liveness honoured for cron and once jobs (it only ever worked for `startup`), and a skip now leaves a
  log line, an event and a history entry instead of a bare `return`.
- `sampleProcessTree` rebuilds the process tree link by link from `ppid` plus age, so a recycled pid
  cannot charge a stranger's CPU to a job and trip the hard resource budget.
- Windows EBUSY on update fixed by running the native binaries from `<configDir>/bin/<stamp>/`.
  Verified live: `orch cli update` went 347 -> 349 with the launcher and tray running.
- One `JOB_FIELD_FLAGS` table feeds `add` and `edit`; nine fields of `Job` had no flag at all, and an
  unknown flag now exits 4 instead of being swallowed.
- P-8 in `guiding-principles.md`: orch classifies a job from the outside and takes the program at its
  word.
