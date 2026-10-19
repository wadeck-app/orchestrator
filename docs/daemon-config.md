# Daemon configuration -- config.yml

File: `<configDir>/config.yml` (default `~/.config/orchestrator/config.yml`).

Read once at daemon startup. Changes take effect after `orch restart`.

## Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoUpdate` | bool | `true` | Enable automatic background updates |
| `appCore` | bool | `true` | Register the dashboard as a module with app-core at every daemon start. See "app-core module" below |
| `supervisedJobs` | bool | `true` | Run each job under its own small supervisor process, so jobs survive a daemon restart or update and are followed again afterwards. `orch stop` then leaves them running and names them; `orch stop --kill-jobs` ends them first. The daemon does not echo a job's output on its own stdout (it is in the run log). `false` runs jobs as children of the daemon again: they stop with it. Where no supervisor executable ships (Linux) the daemon logs a warning at every start and runs jobs unsupervised; `false` silences it. Design and live results: `.claude/plans/2026-10-18_update-with-jobs-running.md` |
| `lateActionWindowMinutes` | int | `30` | A run that ended while the daemon was down is always recorded and announced (`late: true`); it only retries and fires its dependents if it ended at most this many minutes before the daemon came back. `0` never does |
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

`orch kill <id>` stops every live instance of the job and reports how many (`Job "x" killed (3 instances).`); each killed run is recorded as a manual kill in its own history entry and log. The job counts as running while any instance is alive, in the tray and in `/health`.

## Example

```yaml
autoUpdate: false
catchUpInitialDelaySeconds: 300
catchUpStaggerSeconds: 300
onceRetentionDays: 360
onceRetentionMaxJobs: 50
```

## Resource monitor

While a job runs, the daemon samples the CPU and RAM of its whole process tree every 2 seconds. From
the job's third successful run on it holds the run to twice that baseline (the hard budget) and kills
it after 3 consecutive samples over it. Everything it sees is in the job's own log
(`orch logs --job <id>`):

```
[resource-monitor] Over hard budget 1/3 (CPU: ... / RAM: 147MB threshold: 130MB)
[resource-monitor] Hard limit exceeded for 3/3 consecutive samples (...) - killing the process tree
[resource-monitor] Process tree at kill: 3 of 4 processes counted; biggest: pid 4242 node.exe (parent 1000) 120MB, ...
[job:finished] exitCode=1 duration=41.2s reason=resource-limit
```

`reason=resource-limit` tells a kill by the monitor from the job failing on its own. The "3 of 4
processes counted" part says how many processes the tree walk offered against how many were attributed
to the job: a process refused as not the job's (it predates the job, or hangs off a recycled pid) is
the difference between a total that is the job's and one that is not.

### What the baseline is made of

The hard budget is built from the peaks of the job's last 10 successful runs, and only from peaks
measured by the current method (`peakMeasure` in `state.json`, currently 2). Runs recorded before that
are ignored, on purpose: the earlier sampler compared the age each process had when it was *queried*,
and on Windows each process is a separate WMI query, so under load a real child queried seconds after
its shell looked older than it and was dropped. The job was then measured as its idle shell wrapper (17
MB for a job that weighs 130 MB). Keeping those figures would turn the first correct measurement into a
kill, every run, with no way for the baseline to recover (only successful runs feed it).

So after updating to the version that introduced `peakMeasure`, a job runs **without a hard budget until
it has 3 successful runs measured the new way**, then gets a budget that means something. The soft
warning follows the same baseline. Nothing to configure and nothing lost: the old peaks stay in
`state.json` for the dashboard to show.

### Telemetry file

Every sample is also kept in `<configDir>/telemetry/<jobId>.ndjson`, one JSON object per line, so a
UI can draw a job's history and an incident can be read after the fact. It is a record only: failing
to write it is reported once in the job's log and never affects the run.

| `kind` | When | Fields besides `t`, `run`, `pid` |
|--------|------|----------------------------------|
| `start` | The run begins | `soft`, `hard`: the `{ cpuPct, ramMb }` thresholds it is held to, or `null` before there is a baseline |
| `sample` | Every 2 s | `cpuPct`, `ramMb`, `walked`, `counted`, and the 5 biggest `processes` (`pid`, `ppid`, `ramMb`, `cpuPct`) |
| `resource-kill` | The monitor decides to kill | `consecutiveSamples`, `cpuPct`, `ramMb` |
| `end` | The run closes | `exitCode`, `durationMs`, `reason` (`timeout`, `manual-kill`, `resource-limit`, absent for an ordinary finish) |

`t` is the time of the line (ISO), `run` the run's `startedAt`, so lines of different runs in the same
file are told apart. The file is rotated at 2 MiB to `<jobId>.1.ndjson`, and only that one older file
is kept: at most about 4 MiB per job. It sits beside the logs but outside the logs folder, because the
log viewer lists a job's runs by file name.

## app-core module

At every start the daemon tells app-core where the dashboard module lives
(`POST /api/modules/register`), so the jobs, schedule and audit pages appear in app-core without any
setup. It is best effort and never delays the daemon; each outcome is one line in `orch logs`:

```
app-core: module "orchestrator" registered (app-core on port 4850)
app-core: not running, left <app-core config dir>/modules/orchestrator.json for its next start
app-core: module "orchestrator" not registered, app-core is not installed (<dir> does not exist)
app-core: refused module "orchestrator" (HTTP 400): <app-core's reason>. Fix the manifest it names, ...
```

- The registration itself (port, POST, pickup file, the wording above) is `@wadeck-app/app-core-sdk/register`,
  shared with every other module; the daemon only decides when to call it and what to register.
- **Beyond the pages, the module declares two shell widgets.** `navbar` shows the "N jobs / running /
  failed" figures on every page, and `overlay` stacks the failure notifications bottom-right. Both need
  `app-core-cli` 029 or later; an older shell ignores the slots and the figures and notifications are missing.
- **The module outlives the npm folder.** app-core remembers the path of a manifest and reloads it at
  its own every start, and npm replaces the package folder on every update and deletes it on
  uninstall, so registering a path inside it would register a path that dies. The daemon copies the
  module into `<configDir>/app-module/<version>/` and registers the copy. Each start (so after every
  `orch cli update`) it copies the current version if it is not there yet, registers it, and deletes
  the older copies only once app-core holds the new path: accepted, or left as the file app-core reads
  at its next start. If app-core refuses, the older copy stays, because that is still the path it
  remembers. Same shape and same reason as the native launcher binary staged under `<configDir>/bin/`.
- Uninstalling or updating the CLI therefore never leaves app-core pointing at a missing file. The
  module is *not* removed by an uninstall: it belongs to app-core until you remove it there
  (`POST /api/modules/unregister {"id":"orchestrator"}`). Until the daemon runs again its pages answer
  `daemon-not-running`.
- **What is registered is the packaged module**, never the source `manifest.json` (app-core refuses it:
  no `version`, no `backendEntryPath`). The published package ships the content of
  `packages/app-module-orchestrator/dist-module` as `app-module/`, built by
  `BUNDLE_VERSION=<version> npm run package --workspace=packages/app-module-orchestrator`
  (Tailwind stylesheet, then `app-core-cli package`) and copied by `ci/scripts/copy-app-module.sh`.
- Nothing is copied on a machine without app-core. A source checkout registers
  `app-module-orchestrator/dist-module/manifest.json` in place, so run the `package` command above first;
  without it the daemon logs where it looked and how to build it.
- app-core's port is `APP_CORE_PORT` if set, else the port app-core wrote in its own config dir
  (`server.port.json`), else `4850`. The config dir is `~/.config/app-core`, or `APP_CORE_CONFIG_DIR`.
- When app-core is not running but was installed, the daemon leaves the registration in app-core's
  `modules/` folder, which app-core reads at its next start. When app-core was never installed it
  writes nothing at all.
- A development instance (`ORCH_DEV_INSTANCE=1`) never registers, so a checkout cannot replace the
  installed module in app-core.
- `appCore: false` stops all of it.
