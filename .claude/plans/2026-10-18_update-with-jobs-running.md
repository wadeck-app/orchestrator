# Updating orch while jobs run

Status: decided and reviewed (2026-10-18), implementation in progress. Nothing here is specific to app-core: a job stays a generic command.

## Progress (2026-10-18)

| Phase | State |
|---|---|
| 1 supervisor-go + shipping | done, CI green on 3 OS |
| 2 `_finishRun` / `_register` / `_monitor` split, async spawn seam, logger-close order | done; also fixed `job.recovered` (never fired) and the retry/anomaly log markers (never written) |
| 3 supervised launch behind `supervisedJobs` (default false) | done |
| 4 recovery of finished runs, policy C, effect ledger, `state.flushNow`, `lateActionWindowMinutes` | done |
| 5 adoption: `owner.json`, supervisor identity by start time, no second copy of a startup/catch-up job, `detachRuns` on shutdown, `supervised` flag so the updater does not wait for these runs | done in code and tests (cases 3, 4, 5, 6, 8, 11, 12) |
| 5 still open | the spike under the REAL launcher (tray start kills every tray on the machine, so it is not run on a dev machine), cases 13-14, a real `orch cli update` with a running job |
| 6 flag default on, `orch stop` semantics (D5/D6), docs | done (2026-10-19): `supervisedJobs` defaults to `true`, `orch stop` leaves jobs running, `--kill-jobs` ends them. The flag stays as the way to turn it off |

### Live test on the real daemon (2026-10-18, Windows)

Done with temporary `zz-live-*` jobs (removed afterwards) and with the real app-core server and the four real scrapers.

| Scenario | Result |
|---|---|
| Update (`orch cli update`) with 3 to 6 supervised jobs running | daemon back in ~2 s, every run followed again, job output continuous, history entries open and supervised |
| Restart with seven live jobs | all followed again; a startup job was not started a second time (skip recorded as `adopted`) |
| Job still running 38 min after four daemon restarts | killed with `orch kill`: cancelled, `reason=manual-kill`; another one released: normal exit 0 with its full duration |
| 85 s outage; one job ended at +1 s, two at +75 s, one hit its timeout | real exit codes and end times (log markers stamped with the real end), timeout marked, dependents fired only for the recent end, retry skipped with its reason for the old one |
| Outage then retry chain | retry 1, retry 2 and "exhausted" ran in order after the restart |
| Real app-core server under a supervisor, 31 s without a daemon | kept answering on :4850 from the same process, followed again at restart, no second copy |
| The four real scrapers run supervised | exit 0; resource peaks (1361 / 1274 / 1538 MB) match their unsupervised ones |

Defects the live test found, all fixed with a test first: the process-table lookup was done once per run (about a second each on Windows), which delayed readiness and made `orch restart` start a second daemon; that second daemon closed live runs as orphaned; a run that ended in front of the daemon was never marked handled and was replayed at the next start; a retry armed while recovering was dropped by `start()`; a run whose supervisor vanished was waited on for ever; and the command was cut at every letter `s` (a lost backslash), which made the four real scrapers fail with exit 1 for the one cycle they ran supervised.

Decided afterwards (D5 and D6 confirmed): `orch stop` leaves supervised jobs running, names them and says how to end them, and `orch stop --kill-jobs` ends every running job first (checked live: the real app-core server was ended, then restarted by its startup job under a supervisor); the daemon stdout echo of job output is gone; `orch status` never starts the daemon any more (a stopped daemon answers `{"running":false}` / "not running", exit 1; checked live). Still true: macOS and Linux were only exercised by CI.

Confirmed by experiment: without `detachRuns()` a process that holds a supervised run never exits (test/detach-exit.test.js, with a negative control), which is the review's blocker B1 for the scheduler's own handles. Whether the rest of the real daemon exits is part of the real-update check.

Dropped from the plan: a `dryRun` flag in spec.json. A dry run is `command + ' --dry-run'` fired like any other run today, events included, so adopting it as an ordinary run is the same behaviour.

Goal: `orch cli update` and any daemon restart work with jobs running. A job that ends or dies while the daemon is down, and one still alive after it, give the same information and features as if the daemon had not restarted.

## Decisions

| # | Decision | By |
|---|---|---|
| D1 | Every job runs under a per-job **supervisor** (Go, `packages/orchestrator-cli/supervisor-go`), detached from the daemon, started with `detached: true` (spike, below) | user |
| D2 | The supervisor is staged out of `node_modules` with the existing launcher/tray mechanism (`stageBinary`, stamp = platform package version, which only changes when a binary hash changes); a running job needs the file only at launch | user, adapted |
| D3 | A job that ended while the daemon was down: policy C, window 30 min (below) | user |
| D4 | No cooperative heartbeat/progress files from jobs; the supervisor's heartbeat is the liveness evidence | user |
| D5 | `orch stop` leaves jobs running (adopted at the next start); `orch stop --kill-jobs` ends them | proposed, to confirm |
| D6 | The daemon no longer echoes job output to its own stdout (the supervisor owns the pipes) | proposed, to confirm |
| D7 | Supervised jobs shipped behind `supervisedJobs` in `config.yml`, default false; default `true` since 2026-10-19 (live test and CI green on 3 OS). The flag is kept, not removed: `false` is the way back to jobs that are children of the daemon | done |

## Facts (verified in code or by experiment, 2026-10-18)

- `state.closeOrphanedRuns()` closes every open run at start as `orphaned` without looking at the pid (`state.ts:111`, `index.ts:214`); `start()` also closes open entries whose pid is dead as exit code 1 (`scheduler.ts:447-458`).
- `Scheduler.stop()` kills nothing and only clears timers (`scheduler.ts:621`). The per-run sampler and timeout timers are not unref'd. Whether the daemon then fails to exit after `/quit` (and so blocks the launcher's restart) is read from the code, **not yet observed**: phase 5 test.
- `SpawnFn` is synchronous and `_fire` reads `child.pid` at once (`scheduler.ts:1128-1129`); `_killChild` calls `killTreeSync(child.pid)` directly (`:821`).
- End-of-run work hangs off the child's `close` event (`:1379-1480`): `emit('job-finished')` (audit), published events, hooks, retry, dependents, SLA. `jobLogger.close()` (`:1421`) runs before three later `jobLogger.write` calls (`:1446`, `:1465`, `:1475`), which are therefore no-ops: the `[retry]` and anomaly markers never reach the run log today (pre-existing bug).
- State writes are batched on a 500 ms timer; `state.shutdown()` is the only synchronous flush.
- Run log line = `[YYYY-MM-DD HH:MM:SS] text` (UTC), stderr prefixed `[stderr] `, blank lines dropped (`logger.ts:34`, `scheduler.ts:1346-1357`).
- **Spike (Windows, replica of the launcher's Job Object flags, node inside the job, job closed):** a child started with `detached: true` survives; a child started without `detached` (today's `shell:true` jobs) dies; without `SILENT_BREAKAWAY_OK` everything dies. So today's jobs die when the launcher's job closes. macOS/Linux behaviour of the launcher is **not verified**. The spike did not run under the real launcher binary: phase 5 repeats it there.
- Measured (Windows prototype): Go supervisor 12.7 MB private, 7.9 MB working set, 2 MB binary, 0 CPU at a 2 s heartbeat; the same in Node 21.2 MB private, 103 MB working set.
- Platform packages exist for win32-x64, darwin-arm64, darwin-x64 only. On Linux there is no launcher, tray or supervisor package: a Linux install keeps pipe-spawned jobs and says so in the daemon log.

## File contract (run folder `<configDir>/runs/<jobId>/<startedAt in ms>/`)

| File | Writer | Content |
|---|---|---|
| `spec.json` | daemon, before starting the supervisor | `command`, `cwd`, `logPath`, `timeoutSeconds`, `heartbeatMs`, `killGraceMs`, and a `context` block (`jobId`, `label`, `trigger`, `retryAttempt`, `dryRun`) so a run can be finalized even if the job was edited or deleted meanwhile |
| `status.json` | supervisor, atomic rename with retry | `state` (`running` / `exited` / `failed-to-start`), supervisor and child pid and start times, `finishedAt`, `exitCode`, `signal`, `killed`, `killReason`, `timedOut`, `error` |
| `heartbeat` | supervisor | file refreshed every `heartbeatMs`; content = a counter, so a clock jump cannot fake liveness |
| `kill` | daemon | request to end the tree; content = reason (`manual`, `resource-limit`) |
| `owner.json` | daemon | pid + start time of the daemon that supervises the run; only a daemon that finds no live owner may adopt |
| `effects.json` | daemon | which end-of-run effect groups are done (`state`, `events`, `hooks`, `retry`, `dependents`, `audit`) |
| `done` | daemon, last | the end was fully processed |

Environment and secrets are **never written to disk**: the supervisor inherits the job's environment from the process environment of the detached supervisor process (`process.env` + `job.env` + resolved secrets, as `scheduler.ts:1124-1128` builds it today).

The supervisor writes the run log in the daemon's format; the daemon appends its own markers to the same file. The run folder is removed after `done`; `lost` and `failed-to-start` folders are kept 7 days.

## Handle seen by the scheduler

- `SpawnFn` becomes async-capable (`Handle | Promise<Handle>`, awaited in `_fire`), so the existing synchronous test fakes stay valid.
- `handle.pid` is the **job root pid** (the supervisor's child), so the sampler, the state record and `killTree` keep working unchanged.
- Kill while the daemon is alive: write `kill` (reason), then `killTreeSync(pid)` exactly as today, so `kill-job` stays synchronous. The supervisor only uses its own kill path when the daemon is gone.
- Timeout: the daemon keeps its own timer (event and `flushPeaks` at the right moment); the supervisor enforces the same deadline plus a margin, so it only acts if the daemon is gone.

## Policy C: a job that ended while the daemon was down

`late` = `finishedAt` earlier than this daemon's start. `window` = `lateActionWindowMinutes` in `config.yml`, default 30.

| Effect | Always | Only if `now - finishedAt <= window` |
|---|---|---|
| Run history (real exit code, signal, `finishedAt`), peaks, audit line, failure counters | yes | |
| Published events (`job.completed/failed/recovered/anomaly/timed_out/killed_manual`, `alert.*`) with `late: true` and the real `finishedAt` | yes | |
| Hooks `onJobRetry` / `onJobExhausted`, retry scheduling, dependents | | yes |

Beyond the window the log gets one explicit line (`retry/dependents skipped: the run ended <n> min before the daemon came back (window 30 min)`). A `skipped` run (skip exit codes) never retries or fires dependents, late or not.

**Order and idempotence.** (1) record the finished entry and flush state synchronously (`state.flushNow()`), (2) run the effect groups, writing `effects.json` after each, (3) write `done`, (4) remove the folder. A start that finds a finished status without `done` replays only the groups not marked done; an event group interrupted midway may deliver an event twice (consumers dedupe on `jobId` + `startedAt`; whether the queue does is open). Dependents are never fired twice.

## Recovery at daemon start (before `scheduler.start()`)

Synchronous registration of adopted runs in `_running` / `_activeChildren` before any firing. The old `start()` loop that closes dead-pid entries as exit 1 is replaced.

| Found | Action |
|---|---|
| `exited` or `failed-to-start`, no `done` | finalize (policy C) |
| `running`, supervisor pid alive (pid and start time agree with the status, 5 s tolerance), no live `owner.json` | adopt; a stale heartbeat on a live supervisor is logged and re-checked, never `lost` (sleep/resume, load) |
| `running`, supervisor dead, no end recorded | close as `lost` (exit code unknown), warning with the pids; the leftover tree is reported, not killed (pid reuse) |
| open `RuntimeEntry`, no run folder | `orphaned`, as today (job started by a pre-supervisor daemon) |
| `done` present | remove the folder |

After adoption: `startup`, catch-up, `once` and cron firings of a job with an adopted run record a **skip with a reason** ("still running from before the restart") instead of starting a second copy. This is the case of a long-running `startup` job (a server) and must not be started twice.

Adoption restores what the run needs: peaks seeded from the stored entry (never overwritten with lower values), the retry counter derived from `triggeredBy.attempt`, `dryRun` from `spec.json`, telemetry gets an `adopt` event instead of a second `start`. Not restored, and said so in the docs: `hardBreaches` and the soft-limit "already alerted" flag reset; the SLA deadline and pending retry timers are lost on any restart (pre-existing).

## Other daemon changes

- **Shutdown**: `onShutdown` cancels every sampler, timeout and watcher and detaches without finalizing; the daemon must then exit (test with an unref'd/cleared handle set). `--kill-jobs` writes `kill` files first.
- **Updater deferral**: `active_jobs` stops counting supervised runs, so the background auto-update no longer defers forever behind a server job.
- **Signal**: `RuntimeEntry` gets an optional `signal`; `exitCode` keeps today's `code ?? 1`.
- **Tray**: adopted runs emit `job-started` after the tray subscribes (`index.ts:351`); late `job-finished` carries `late`.
- **`finalizeRun`** keeps today's order but closes the run logger **after** the effects, so the `[retry]` and anomaly markers finally reach the log (visible change, covered by a test).
- **Wait-mode callers** (`--wait`) still get a connection error when the daemon restarts; unchanged, documented.
- **Out of scope**: `ExecManager` (piped, killed at shutdown), pending retry/SLA timers.
- **Build/ship**: `supervisor-go` built like `tray-go` (`build-supervisor`), copied into the platform packages, included in the publish hash. Done.

## Cases every phase is tested against

| # | Case | Expected |
|---|---|---|
| 1 | Ends normally while the daemon is down | real exit code, events `late`, retry/dependents per window |
| 2 | Dies (crash, SIGKILL, OOM) while down | signal recorded, as 1 |
| 3 | Alive after restart | adopted: running, peaks/telemetry resume, kill works, timeout applies, `maxConcurrency` counts it |
| 4 | Timeout elapses while down | supervisor ended it; `timedOut`; events `late` |
| 5 | `orch kill` right after restart | tree ended, `killed_manual` |
| 6 | Supervisor dies, job alive | `lost`, warning with pids |
| 7 | Machine rebooted | nothing alive: `lost` / orphaned |
| 8 | Pid reused | start times vouch; no foreign process adopted |
| 9 | Daemon crashes during finalization | replay of missing groups only; dependents once |
| 10 | Finished long ago (beyond the window) | recorded, events `late`, retry/dependents skipped with the reason |
| 11 | Startup job with an adopted run | skip recorded, no second copy |
| 12 | Two daemons (old lingering, new) | only one adopts (`owner.json`) |
| 13 | Dry run, edited or deleted job, run log deleted while running | finalized from `spec.json` context; no crash |
| 14 | Grandchild outliving the shell; disk full on `status.json`; sleep/resume | documented behaviour, tested where possible |
| 15 | Crash between `done` and the state flush | impossible by order (1) |

## Phases (tests first; CI green before the next)

| Phase | Content | Gate |
|---|---|---|
| 1 | `supervisor-go`: contract, run-log format, kill reason, status write retry, millisecond folder names; build/ship scripts | Go tests on 3 OS (partly done) |
| 2 | Characterization tests of the current end-of-run behaviour, then `finalizeRun` extraction, async `SpawnFn`, `_attach` split, logger-close order | the whole existing suite unchanged, new characterization tests |
| 3 | `supervisedSpawn` + staging + `supervisedJobs` flag (default off), shutdown writes kill files so D5 is unchanged | cases 5 and the file contract on a live run |
| 4 | Recovery of finished runs only (cases 1, 2, 9, 10), `state.flushNow`, `effects.json` | cases 1, 2, 9, 10 |
| 5 | Adoption (cases 3, 4, 6, 8, 11, 12, 13), `owner.json`, shutdown detach and exit, spike repeated under the real launcher, updater deferral | cases 3-13 + a real `orch cli update` with a running job on this machine |
| 6 | Flag default on and removed, `orch stop` semantics (D5/D6), docs, release caveat | manual |

## Caveats

- The first update to the first supervisor-enabled version still stops jobs started by the old daemon (they hold pipes to it). Later updates preserve running jobs.
- `orch stop` changes (D5) and the daemon stdout echo goes (D6): to confirm.
- One extra process per running job, about 13 MB private each (measured, Windows).
- On Windows a grandchild that outlives the shell survives a timeout (`taskkill /T` needs a live root); a per-job Job Object in the supervisor would fix it, left for later.

## Open points

- Does the queue's `/push` dedupe an event delivered twice? Ask queue-owner.
- Heartbeat period (2 s) and the 5 s adoption tolerance are choices, not measurements.
