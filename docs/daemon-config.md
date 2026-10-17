# Daemon configuration -- config.yml

File: `<configDir>/config.yml` (default `~/.config/orchestrator/config.yml`).

Read once at daemon startup. Changes take effect after `orch restart`.

## Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoUpdate` | bool | `true` | Enable automatic background updates |
| `catchUpInitialDelaySeconds` | int | `300` | Seconds to wait after daemon start before firing the first catch-up job |
| `catchUpStaggerSeconds` | int | `300` | Seconds between consecutive catch-up jobs on startup |
| `onceRetentionDays` | int | `360` | Days a spent `once` job is kept before being pruned |
| `onceRetentionMaxJobs` | int | `50` | How many spent `once` jobs are kept at most |
| `auditMaxBytes` | int | `5242880` | Size at which `audit.ndjson` is rotated. `0` turns rotation off |
| `auditMaxFiles` | int | `5` | Rotated audit files kept, newest first |

Integers must be whole and non-negative. `0` is valid and means "keep none", except `auditMaxBytes` where it means "never rotate".

## Audit trail

`<configDir>/audit.ndjson` is the live file. Past `auditMaxBytes` it is renamed `audit.<timestamp>.ndjson` and a new one starts; only the newest `auditMaxFiles` rotated files are kept, so the trail is bounded at about 30 MiB by default. The dashboard and `list-audit` read across the live and rotated files.

Fields on `job.completed` and `job.skipped`:

| Field | Meaning |
|-------|---------|
| `exitCode` | The real exit code, also for skipped runs |
| `durationMs` | Wall-clock run time |
| `trigger` | What started the run: `cron`, `manual`, `retry`, `dependency`, ... |
| `reason` | `job.skipped` only: `skipExitCodes` |

`orch trigger` with an empty, malformed or unknown job id is refused with an error and writes no audit entry.

## Invalid values

A line the parser cannot use is reported in the daemon log (`orch logs`) and the default applies:

```
config: config.yml line 4: onceRetentionDays must be a non-negative whole number, found "soon" -- using 360
config: config.yml line 7: unknown key "onceRetentionDay", ignored. Known keys: autoUpdate, ...
```

Unknown keys are reported too: a typo used to be indistinguishable from "not configured".

## Background update checks

The daemon checks for a new version every 30 minutes (not configurable here -- it's the daemon's
own spawn interval, not a `config.yml` key). `@wadeck-app/shared-updater`'s own check-interval
throttle, which other `@wadeck-app` CLIs rely on when they have no schedule of their own, is
bypassed for this daemon (`skipThrottle`) since the two would otherwise beat against each other.

## Past `once` jobs

A `once` job that has fired is marked `spent` + `spentAt` in `registry.json` instead of being deleted,
so its run history and audit entries still have a definition to point at.

Pruning applies whichever bound is reached first, on daemon start and after each firing. `orch list`
hides spent jobs (use `--past`); the dashboard has a "Past once" filter chip.

## Catch-up behaviour

On startup, for each cron job with `missedFiring: catch-up`, the scheduler compares the last expected firing time (computed from the cron schedule, up to 48h back) against the last recorded run. If the last expected firing is more recent than the last run, the job was missed and is queued for catch-up.

Catch-up jobs fire with staggered delays to avoid simultaneous load (e.g. after hibernation):
- Job 1 fires after `catchUpInitialDelaySeconds`
- Job 2 fires after `catchUpInitialDelaySeconds + catchUpStaggerSeconds`
- Job N fires after `catchUpInitialDelaySeconds + (N-1) x catchUpStaggerSeconds`

Only the **most recent** missed firing is caught up per job -- multiple missed days do not accumulate.

## Limiting concurrent runs -- `maxConcurrency`

Per-job option, not a `config.yml` key. `orch add|edit <id> --max-concurrency <n>`; clear it with `orch edit <id> --unset maxConcurrency`. Absent means no limit.

A firing that finds `n` runs already alive is refused, whatever started it: schedule, catch-up, retry, dependency or `orch trigger`. A refusal is a skip, not a failure:

- `job.skipped` event with `reason: concurrency`, `running` and `maxConcurrency` on the event bus. Only a refused `orch trigger` reaches `audit.ndjson`, as `job.trigger_refused`; scheduled refusals are not audited.
- A `[job:skipped] reason=concurrency` line in the log of the run holding the slot.
- No run-history entry and no log file of its own, so the dashboard keeps showing the real run as running.
- `orch trigger` answers `{ status: "already-running", running, maxConcurrency }` and exits 0. `--force` starts another instance anyway.
- A refused retry is not rescheduled; a refused `once` firing still marks the job spent.

Above 1 is enforced, but `orch kill` only reaches the most recently started instance.

## Example

```yaml
autoUpdate: false
catchUpInitialDelaySeconds: 300
catchUpStaggerSeconds: 300
onceRetentionDays: 360
onceRetentionMaxJobs: 50
```
