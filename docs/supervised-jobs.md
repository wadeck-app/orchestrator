# Supervised jobs

Each job runs under its own small supervisor process (`packages/orchestrator-cli/supervisor-go`), started detached from the daemon. A daemon restart, `orch stop` or `orch cli update` therefore leaves running jobs running, and the next daemon follows them again. Setting: `supervisedJobs` in `docs/daemon-config.md`.

## Run folder

`<configDir>/runs/<jobId>/<startedAt in ms>/`

| File | Writer | Content |
|---|---|---|
| `spec.json` | daemon, before starting the supervisor | `command`, `cwd`, `logPath`, `timeoutSeconds`, `heartbeatMs`, `killGraceMs`, and a `context` block (`jobId`, `label`, `trigger`, `retryAttempt`, `dryRun`) so a run can be finalized even if the job was edited or deleted meanwhile |
| `status.json` | supervisor, atomic rename with retry | `state` (`running` / `exited` / `failed-to-start`), supervisor and child pid and start times, `finishedAt`, `exitCode`, `signal`, `killed`, `killReason`, `timedOut`, `error` |
| `heartbeat` | supervisor | refreshed every `heartbeatMs`; content is a counter, so a clock jump cannot fake liveness |
| `kill` | daemon | request to end the tree; content is the reason (`manual`, `resource-limit`) |
| `owner.json` | daemon | pid and start time of the daemon that follows the run; only a daemon that finds no live owner may adopt |
| `effects.json` | daemon | which end-of-run effect groups are done (`state`, `events`, `hooks`, `retry`, `dependents`, `audit`) |
| `done` | daemon, last | the end was fully processed |

Environment and secrets are never written to disk: the supervisor inherits them from its own process environment. The supervisor writes the run log in the daemon's format and the daemon appends its own markers to the same file. The run folder is removed after `done`; `lost` and `failed-to-start` folders are kept 7 days.

## Following a run

- `handle.pid` is the job's root pid (the supervisor's child), so sampling, state and tree kill work as for an unsupervised job.
- A kill while the daemon is alive writes `kill` and then ends the tree itself; the supervisor only uses its own kill path when the daemon is gone.
- The daemon keeps its own timeout timer; the supervisor enforces the same deadline plus a margin, so it only acts when the daemon is gone.

## At daemon start

Before anything fires, every run folder is looked at:

| Found | Action |
|---|---|
| `exited` or `failed-to-start`, no `done` | finalize the end (below) |
| `running`, supervisor alive (pid and start time agree with the status, 5 s tolerance), no live `owner.json` | adopt. A stale heartbeat on a live supervisor is logged and re-checked, never `lost` (sleep, load) |
| `running`, supervisor dead, no end recorded | close as `lost` (exit code unknown) with a warning naming the pids; the leftover tree is reported, not killed (pid reuse) |
| open history entry, no run folder | `orphaned` (job started by a daemon without supervisors) |
| `done` present | remove the folder |

After adoption, `startup`, catch-up, `once` and cron firings of a job with an adopted run record a skip ("still running from before the restart") instead of starting a second copy. Adoption restores peaks (never overwritten with lower values), the retry counter, `dryRun` and telemetry (an `adopt` event instead of a second `start`). Not restored: `hardBreaches` and the soft-limit "already alerted" flag reset; the SLA deadline and pending retry timers are lost on any restart.

## A run that ended while the daemon was down

The end is handled as if the daemon had seen it, flagged `late` (`finishedAt` earlier than this daemon's start). `lateActionWindowMinutes` (default 30) decides what acts:

| Effect | Always | Only if the run ended within the window |
|---|---|---|
| Run history (real exit code, signal, `finishedAt`), peaks, audit line, failure counters | yes | |
| Published events (`job.completed/failed/recovered/anomaly/timed_out/killed_manual`, `alert.*`) with `late: true` and the real `finishedAt` | yes | |
| `onJobRetry` / `onJobExhausted` hooks, retry scheduling, dependents | | yes |

Beyond the window the run log gets one line saying retry and dependents were skipped. A `skipped` run (skip exit codes) never retries or fires dependents.

Order: record the finished entry and flush state synchronously, run the effect groups writing `effects.json` after each, write `done`, remove the folder. A start that finds a finished status without `done` replays only the groups not marked done, so dependents never fire twice; an event group interrupted midway may deliver an event twice.

## Limits

- The first update to the first supervisor-enabled version still stops jobs started by the old daemon (they hold pipes to it).
- `orch exec` commands are never supervised.
- One extra process per running job, about 13 MB private (measured on Windows).
- On Windows a grandchild that outlives the shell survives a timeout (`taskkill /T` needs a live root).
- Callers waiting with `--wait` get a connection error when the daemon restarts.
- The heartbeat period (2 s) and the 5 s adoption tolerance are choices, not measurements.
