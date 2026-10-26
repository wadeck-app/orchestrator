# Daemon configuration -- config.yml

File: `<configDir>/config.yml` (default `~/.config/orchestrator/config.yml`).

Read once at daemon startup. Changes take effect after `orch restart`.

## Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoUpdate` | bool | `true` | Enable automatic background updates |
| `appCore` | bool | `true` | Register the dashboard as a module with app-core at every daemon start. See "app-core module" below |
| `supervisedJobs` | bool | `true` | Run each job under its own small supervisor process, so jobs survive a daemon restart or update and are followed again afterwards. `orch stop` then leaves them running and names them; `orch stop --kill-jobs` ends them first. The daemon does not echo a job's output on its own stdout (it is in the run log). `false` runs jobs as children of the daemon again: they stop with it. Where no supervisor executable is found the daemon logs a warning at every start and runs jobs unsupervised: running jobs are killed with the daemon on `orch stop`, `orch restart` and `orch cli update`, each of which warns first and names them. That is every Linux npm install: no platform package carries a supervisor; linux-x64 has one only in a source checkout (`npm run build-supervisor`), linux-arm64 never. `false` only hides the message. Design and live results: `.claude/plans/2026-10-18_update-with-jobs-running.md` |
| `jobsNoColor` | bool | `true` | Start every job and `orch exec` with `NO_COLOR=1` and `FORCE_COLOR=0`, and strip escape sequences from job output. `false` hands jobs the daemon's environment as it is. See "Colour" below |
| `lateActionWindowMinutes` | int | `30` | A run that ended while the daemon was down is always recorded and announced (`late: true`); it only retries and fires its dependents if it ended at most this many minutes before the daemon came back. `0` never does |
| `catchUpInitialDelaySeconds` | int | `300` | Seconds to wait after daemon start before firing the first catch-up job |
| `catchUpStaggerSeconds` | int | `300` | Seconds between consecutive catch-up jobs on startup |
| `onceRetentionDays` | int | `360` | Days a spent `once` job is kept before being pruned |
| `onceRetentionMaxJobs` | int | `50` | How many spent `once` jobs are kept at most |
| `auditMaxBytes` | int | `5242880` | Size at which `audit.ndjson` is rotated. `0` turns rotation off |
| `auditMaxFiles` | int | `5` | Rotated audit files kept, newest first |
| `logMaxSizeMb` | int | `50` | Size of one segment of a run's log. `0` never rotates (jobs without their own `logRotation`). Max `10240`. See "Rotating the log of a run" |
| `logKeepSegments` | int | `5` | Segments of a run kept, newest first. `1`-`1000` |

Integers must be whole and non-negative. `0` is valid and means "keep none", except `auditMaxBytes` and `logMaxSizeMb` where it means "never rotate".

## Environment: `ORCH_NO_TRAY`

`ORCH_NO_TRAY=1` starts no tray process and kills none. For development and tests only; production never sets it.

- The daemon logs `tray disabled by ORCH_NO_TRAY=1` once at start, so a variable left set by mistake shows.
- Any other value leaves the tray on (and is logged as ignored).
- `npm test` sets it for the whole run (`test/helpers/isolate-config-dir.js`): a daemon a test kills by force leaves a ghost icon in the Windows taskbar.

## Where jobs get their PATH (macOS)

A job inherits the daemon's `PATH`, and a job's own `env: { PATH }` **replaces** it (it is not appended). The daemon's PATH depends on how it started:

| Started by | PATH |
|---|---|
| `orch start` / `orch restart` (the CLI spawns the Go launcher directly, launchd is not involved) | The PATH of the shell that ran the command |
| launchd at login (`~/Library/LaunchAgents/com.wadeck.orchestrator.plist`) | `EnvironmentVariables.PATH` of the plist |

launchd never reads `~/.zshrc`, so a tool found only through it (`~/.local/bin/claude`) failed with `command not found` (exit 127) in a login-started daemon. On macOS the plist now carries the PATH of your login shell:

- Captured with `$SHELL -l -i -c` (fallback `/bin/zsh` when `$SHELL` is unset or not an absolute executable path; that is warned about), 5 s timeout, no PATH inherited from the daemon (the previous plist PATH would otherwise live forever).
- Order: the daemon's node directory, your entries, then `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` if absent. Your entries therefore come before the system ones, as in a terminal: a `~/bin/git` shadows `/usr/bin/git` for jobs too.
- Only absolute directories are kept (relative entries are dropped and named in a warning), deduplicated, at most 100.
- **Frozen at write time.** The plist is rewritten at every daemon start (and by `orch install`), so a `~/.zshrc` edit applies after `orch restart`. Do not edit the plist by hand: it is overwritten.
- See what a job gets: `orch exec 'printenv PATH'`, or read `EnvironmentVariables` in the plist.

When the capture fails (timeout, non-zero exit, shell missing, no markers in the output) the plist gets a default PATH (node dir, `~/.local/bin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin`, then the fixed entries) and the daemon log (`orch logs`) shows:

```
start-at-login warning: could not read the PATH of your login shell (<reason>). The start-at-login entry uses a default PATH instead: ... Fix: make `/bin/zsh -l -i -c 'echo $PATH'` run cleanly in under 5s ..., then run `orch restart` to rewrite the plist.
```

Fix: run that command in a terminal; a slow or blocking command in `~/.zshrc` / `~/.zprofile` (or one that prompts) is the usual cause. Output printed by rc files is harmless (the PATH is read between unique markers). Windows start-at-login uses the registry and is unaffected.

## Colour

With `jobsNoColor: true` (default) a job, supervised or not, and an `orch exec` start with:

| Variable | Value | Why |
|----------|-------|-----|
| `NO_COLOR` | `1` | The convention most tools honour |
| `FORCE_COLOR` | `0` | chalk, supports-color and node read it before `NO_COLOR`, so an inherited `FORCE_COLOR=1` would win |
| `CLICOLOR_FORCE` | removed | An inherited `1` forces colour in tools that use it |

The job's own `env` (and its secrets) win, per variable: a job that sets `FORCE_COLOR=1` keeps it and still gets `NO_COLOR=1`. `TERM` and `COLORTERM` are left alone: a piped stdout is never a terminal, and changing `TERM` would also change cursor and progress behaviour.

Some programs print escape sequences whatever the environment says, so they are stripped as well (colour, cursor and erase codes, OSC strings; `\r` progress redraws are kept):

- Job output lines are written to the run log file without them, for direct and supervised jobs alike. The daemon's own lines are untouched.
- `orch job <jobId> logs` and `orch logs` (snapshot, `-f`, `--json`) strip what they print. `--raw` prints the file byte for byte, which also shows sequences in logs written before this.
- The dashboard log pane strips at display. `orch exec` output is stripped too.

Read at daemon start, like every key: `orch restart` after changing it.

## Audit trail

`<configDir>/audit.ndjson` is the live file. Past `auditMaxBytes` it is renamed `audit.<timestamp>.ndjson` and a new one starts; only the newest `auditMaxFiles` rotated files are kept, so the trail is bounded at about 30 MiB by default. The dashboard and `list-audit` read across the live and rotated files.

Fields on `job.completed` and `job.skipped`:

| Field | Meaning |
|-------|---------|
| `exitCode` | The real exit code, also for skipped runs |
| `durationMs` | Wall-clock run time |
| `trigger` | What started the run: `cron`, `manual`, `retry`, `dependency`, ... |
| `reason` | `job.skipped`: `skipExitCodes`. `job.completed` of a run ended by force: `timeout`, `manual-kill` or `resource-limit` (absent otherwise) |
| `late` | `true` when the run ended while the daemon was down and it learned of it at its next start (absent otherwise) |

The same two facts are stored on each history entry in `state.json` as `endReason` (same values as `reason`) and `late`. `cancelledByUser` is kept for older readers. Entries recorded before these fields existed have neither: a legacy null exit code is shown as "Cancelled", never as a timeout.

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

### Interrupted updates and rollback

The updater (`@wadeck-app/shared-updater`) journals the install in `<configDir>/update-state.json` (`status: "applying"`, with the updater `pid` and the `npmPid`) before it runs `npm install -g`. After the install it verifies the installed version and runs `orch cli self-check`; a failed install, a version mismatch or a failed self-check reinstalls the previous version.

If an update was interrupted (machine off, process killed), do nothing: the next update run (daemon start, every 30 minutes, or `orch cli update`) finds `applying`, waits for or stops the orphaned npm, keeps the target if it is fully installed and passes the self-check, and otherwise reinstalls the previous version. The result is logged in `logs/<date>.ndjson` (`orch logs`) and shown by `orch` as `Rollback to ...` or `Update failed (...)`; a failure carries a `Fix manually: npm install -g ...` command.

- `orch` and the daemon report an `applying` state: "in progress" while the updater lives, "interrupted" otherwise.
- If `orch` itself is gone, run `npm install -g @wadeck-app/orchestrator-cli@latest`.
- A development build (repo checkout, version not `YYYY.M.D-BBB-hash`) never updates: `orch cli update`, the daemon's checks and the tray refuse with "this is a development build (version X): it does not update the global install".

## Past `once` jobs

A `once` job that has fired is marked `spent` + `spentAt` in `registry.json` instead of being deleted,
so its run history and audit entries still have a definition to point at.

Pruning applies whichever bound is reached first, on daemon start and after each firing. `orch list`
hides spent jobs (use `--past`); the dashboard has a "Past once" filter chip.

## What removing a job deletes

`orch remove <id>` (also `DELETE /api/jobs/:id`) deletes the data derived from the job's runs, so a job later added under the same id starts clean.

| Deleted | Kept |
|---|---|
| `telemetry/<id>.ndjson` and `.1.ndjson` | `logs/jobs/<id>/` (pruned by age, 120 days) |
| `resource-history/<id>.ndjson` | |
| `runs/<id>/` folders of finished runs | `runs/<id>/` folders whose supervisor is still `running` |
| the job's `state.json` history | `tmp/<id>/` when it holds files (the job's own output) |
| `tmp/<id>/` when empty | |

- A job with a run in progress keeps its telemetry, resource history and history: the run is still writing them. They are listed as `leftovers`.
- A file that cannot be deleted (locked on Windows) never fails the removal. The daemon log has one line per path and the reply carries `leftovers: [{path, reason}]` (CLI: printed on stderr; REST: `200` instead of `204`). Delete those by hand.
- Adding a job whose telemetry or resource history already exists (older version, crash) drops them first and logs one line.
- The audit line `job.deleted` carries `cleaned: {telemetry, resourceHistory, runs}` (counts).
- Purge logs by hand: delete `<configDir>/logs/jobs/<id>/` while no run of the job is going.

## Manual jobs

`orch add manual <id> --command "..."` creates a job the scheduler never fires: nothing is armed at
daemon start or when it is added, it is never caught up, and `orch timers` / `orch status` /
`get-daemon-info` report no problem for it. It runs only on `orch trigger <id>`, `POST /api/jobs/:id/trigger`
or the dashboard Trigger button.

| Aspect | Behaviour |
|---|---|
| After a run | Kept (not spent, unlike `once`); history, logs, telemetry and resource history accumulate |
| Retry | `retryOnExitCodes` / `retryDelays` apply to a failed triggered run, as for every type |
| Refused fields | `schedule`, `delaySeconds`, `delayMs`, `scheduledAt`, `missedFiring`, `activeFrom`, `activeUntil`: error "Manual jobs have no schedule" |
| Everything else | `timeoutSeconds`, `maxConcurrency`, `skipExitCodes`, `liveness`, `resourceLimits`, `env`, `cwd`, `triggerMode`, `description` |
| Type change via the API (`edit-job` `updates.type`) | To `manual`: the fields above are dropped and named in the `job.edited` audit entry (`clearedForType`, `note`). From `manual`: the new type's required fields must be sent (cron needs `schedule`, once needs `delayMs`; `scheduledAt` is stamped). `orch edit` has no `--type` flag |

## Catch-up behaviour

On startup, for each cron job with `missedFiring: catch-up`, the scheduler compares the last expected firing time (computed from the cron schedule, up to 48h back) against the last recorded run. If the last expected firing is more recent than the last run, the job was missed and is queued for catch-up.

Catch-up jobs fire with staggered delays to avoid simultaneous load (e.g. after hibernation):
- Job 1 fires after `catchUpInitialDelaySeconds`
- Job 2 fires after `catchUpInitialDelaySeconds + catchUpStaggerSeconds`
- Job N fires after `catchUpInitialDelaySeconds + (N-1) x catchUpStaggerSeconds`

Only the **most recent** missed firing is caught up per job -- multiple missed days do not accumulate.

## Documenting a job -- `description`

Per-job option, not a `config.yml` key. `orch add|edit <id> --description "<text>"`; clear it with `orch edit <id> --unset description`. Documentation only: no effect on scheduling.

- Plain text, line breaks allowed, stored trimmed; empty or whitespace-only means absent.
- At most 2000 characters (counted on the trimmed text). Longer is refused with the limit and the actual length, never truncated. Over HTTP the refusal is a 400 `{ "error": "<sentence>" }`.
- Visible in `orch show` and `orch list --json` (not in the one-line `orch list`), `GET /api/jobs`, and export/import (`POST /api/jobs/import` adds the jobs one by one: a refused job does not stop the others; the answer is `{ imported, failed, results }` with `results[].error` holding the daemon's sentence for each refused job, and the status is 422 when any was refused). The dashboard shows its first line on the job card, the full text on the job page, and the jobs search matches it.
- The `job.edited` audit line lists `description` among the changed fields; the text is not logged.

## Limiting concurrent runs -- `maxConcurrency`

Per-job option, not a `config.yml` key. `orch add|edit <id> --max-concurrency <n>`; clear it with `orch edit <id> --unset maxConcurrency`. Absent means no limit.

A firing that finds `n` runs already alive is refused, whatever started it: schedule, catch-up, retry, dependency or `orch trigger`. A refusal is a skip, not a failure:

- `job.skipped` event with `reason: concurrency`, `running` and `maxConcurrency` on the event bus. Only a refused `orch trigger` reaches `audit.ndjson`, as `job.trigger_refused`; scheduled refusals are not audited (a job every minute behind a long run would write a line per minute). The rarer refusals are: a startup or catch-up firing refused because its run is still going after a restart (`reason: adopted`) and a liveness skip are audited as `job.skipped` with their reason.
- A `[job:skipped] reason=concurrency` line in the log of the run holding the slot.
- No run-history entry and no log file of its own, so the dashboard keeps showing the real run as running.
- `orch trigger` answers `{ status: "already-running", running, maxConcurrency }` and exits 0. `--force` starts another instance anyway.
- A refused retry is not rescheduled; a refused `once` firing still marks the job spent.

`orch kill <id>` stops every live instance of the job and reports how many (`Job "x" killed (3 instances).`); each killed run is recorded as a manual kill in its own history entry and log. The job counts as running while any instance is alive, in the tray and in `/health`.

## Restarting a long-running job

A job is long-running when `timeoutSeconds` is `0` (a process that must stay up). Restart ends every running instance, waits until each is gone, then starts a new run as a manual trigger.

| Surface | Entry point |
|---|---|
| CLI | `orch restart-job <id> [--json]` (`orch restart` restarts the daemon; `orch restart <id>` is refused) |
| Daemon RPC | `restart-job { id }` |
| HTTP | `POST /api/jobs/:id/restart`, also published by the app module |
| Dashboard | "Restart" button, shown only for a running job with `timeoutSeconds` 0; asks first. A page may declare `$outputs.onRestart` to handle it instead |

- Any job is accepted by the RPC and the CLI; only the button is limited to long-running jobs. A job that was not running is simply started (`wasRunning: false`).
- Answer: `{ id, wasRunning, killed, started, pid, skipped?, reason? }`. HTTP status is 200 for a refused start too.
- A start is refused (`started: false`, `skipped` = `liveness` | `concurrency` | `adopted`, `reason` says the fix) when the liveness check still says the target is alive, the job is at `maxConcurrency`, or the run is followed by another daemon. With no `skipped`, the old instance did not end within 15 s and no second copy was started. The old instance was ended in every case; the CLI exits 1.
- Unknown, disabled and spent (`once`) jobs are errors (HTTP 404 for unknown, 409 for the others), nothing is audited.
- The ended run keeps its normal manual-kill record. One `job.restarted` audit line is written (`jobId`, `label`, `wasRunning`, `killed`, `started`, `skipped?`).
- Unlike a plain `orch trigger`, restart runs the liveness check before starting.

## Keeping a job up -- `restartOnExit`

For a server that must come back after ANY exit: `orch add startup web --command "..." --timeout 0 --restart-on-exit`. `true` means the defaults below; an object tunes them.

| Key (flag) | Default | Meaning |
|---|---|---|
| `strategy` (`--restart-strategy`) | `exponential` | `fixed`, `linear` or `exponential` pause between restarts |
| `initialDelaySeconds` (`--restart-delay`) | `1` | Pause before restart 1, above 0 |
| `factor` (`--restart-factor`) | `2` | exponential only: pause x factor each time, above 1 |
| `stepSeconds` (`--restart-step`) | initial delay | linear only: pause + step each time |
| `maxDelaySeconds` (`--restart-max-delay`) | `30` | linear and exponential: ceiling of the pause, at least the initial delay |
| `maxRestarts` (`--restart-max`) | `10` | Restarts allowed within `windowSeconds`; one more and the job is given up on |
| `windowSeconds` (`--restart-window`) | `300` | Sliding window the limit is counted over |
| `stableAfterSeconds` (`--restart-stable-after`) | `900` | A run that stayed up this long clears the backoff and the restart count |

- Restarted: exit code 0, any failure, a signal, the job's own timeout (a job with the default 300 s timeout and `restartOnExit` is killed and restarted every 5 minutes: use `--timeout 0`), a hard resource kill, a skip code, a start that failed.
- Never restarted: a manual stop (`orch kill`, `restart-job`, the dashboard). A kill during the wait before a restart cancels it (`orch kill` says so). A manual trigger, the schedule or a dependency starting the job also supersedes a pending restart and clears the counters.
- Giving up: `job.restart_abandoned`, a `[restart] giving up` line in the last run's log and a line in the daemon log. The job stays stopped until `orch trigger <id>`, which starts with a full budget. With the defaults a job that dies at once is abandoned after 10 restarts (about 3 minutes).
- A pending restart is dropped when the job is disabled or removed, or when `restartOnExit` is removed; an edit of other fields keeps it. Each case is one line in the daemon log. A restart is skipped when the job is already running.
- Without a supervisor (`supervisedJobs: false`, or its binary missing from the install) a daemon stop kills the run and nothing restarts it until the next start's schedule or trigger.
- The daemon stopping never restarts or counts anything: supervised runs are detached and followed again by the next daemon, which starts no second copy (the startup firing is refused as `adopted`). The attempt and window counters live in memory: a daemon restart starts them again, except that a restarted run keeps its attempt number.
- Option that its strategy ignores (`factor` with `fixed`...), zero or negative values, an unknown strategy or key are refused by `orch add`, `orch edit` and the API with the key to fix. A registry.json edited by hand is not refused at load: the daemon logs the problem at start, restarts nothing for an invalid setting.
- With `retryOnExitCodes`/`retryDelays` on the same job: refused by `add`/`edit`. In a hand-edited registry `restartOnExit` wins and the retry settings are ignored (logged at start).
- `orch edit <id> --restart-delay 5` changes only the given keys; `--unset restartOnExit` turns the policy off.
- Events: `job.restart_scheduled` and `job.restart_abandoned`; the restarted run is `job.started` with `trigger: "restart"`. `orch timers` shows a pending restart as a `restart` timer.

## Rotating the log of a run -- `logRotation`

A run has one log (`logs/jobs/<id>/<id>-<stamp>.log`). A server job (`--timeout 0`) used to grow it without bound; now the run continues in the next segment once the next line would take the current one over the limit.

| Key (flag) | Default | Meaning |
|---|---|---|
| `maxSizeMb` (`--log-max-size`) | `50` (config.yml `logMaxSizeMb`) | Segment size, decimals allowed, min `0.001`, max `10240`. `0` = never rotate this job |
| `keepSegments` (`--log-keep`) | `5` (config.yml `logKeepSegments`) | Newest segments kept, `1`-`1000` |

A run therefore keeps at most about 250 MB by default. A job's keys override the daemon-wide values key by key; `orch edit <id> --log-keep 9` changes only that key; `--unset logRotation` goes back to the daemon-wide values. Invalid values are refused by `add`, `edit` and the API with the key (and flag) to fix.

- Naming: segment 1 is the plain `<id>-<stamp>.log`, later ones `<id>-<stamp>.log.2`, `.log.3`... Never renamed (Windows cannot rename an open file). Readers that only know `*.log` see segment 1 and ignore the rest; once segment 1 is dropped, such a reader no longer sees the run.
- A line is never split: a line goes whole into one segment, a segment holds up to the limit exactly, and a line longer than the limit sits alone in its own segment.
- Dropping: the writer that starts segment N deletes segments up to N-`keepSegments`. When it did, the new segment opens with `[orch] log rotation: K earlier segments of this run were dropped (...)`. A segment a reader holds open on Windows is deleted at the next rotation.
- Both writers behave the same: the supervisor writes the job's output, the daemon its markers (`[job:started]`, `[job:finished]`) into the same run. They share no state; each follows the files, so the daemon's end marker lands in the newest segment. The limits reach the supervisor in `spec.json` (`logRotation: {maxBytes, keepSegments}`), fixed when the run starts: editing the job does not change a run in progress. A run started before this feature has no limits and stays one file.
- Retention (120 days, or more than 100 runs and older than 30 days) counts runs, not files, and removes all the segments of a run.
- Readers:
  - `orch job <id> logs`: segments are one log in order; `-n` counts across them; `-f` goes on when the writer moves to the next segment (segments dropped while following are reported on stderr); `--list` shows `SEGMENTS` (`3 (+2 dropped)`) and `SIZE`, `--json` adds `segments`, `droppedSegments`, `sizeBytes`. Dropped segments at the start are announced on stderr.
  - `orch logs --job <id>`: today's segments in order.
  - Dashboard (`/api/logs/<id>/runs` and `/stream`): one entry per run with the total size (plus `segments`, `droppedSegments`); the stream replays all kept segments and follows into the next one without a run change. The run picker UI shows the total size only.
  - Progress/ETA strategies: `tail` reads the end of the run across segments; the head (`readFrom`, fingerprint) is the first segment kept, so a rotated run teaches the learned strategy only that head, and a byte offset above 0 addresses that segment.

## Bounding a liveness command -- `liveness.timeoutSeconds`

The `command` liveness strategy runs `liveness.command` before each firing and skips the job when it exits 0. A command that never ends used to hold the firing forever; it is now killed (whole process tree) after `timeoutSeconds`.

| Key (flag) | Default | Range |
|---|---|---|
| `timeoutSeconds` (`--liveness-timeout`) | `30` | whole seconds, `1`-`3600`; `command` strategy only |

- On timeout the target counts as **not alive**: the job starts. The daemon log gets a `[scheduler]` line naming the job and the flag to raise.
- Any other strategy with `timeoutSeconds`, or a value outside the range, is refused by `add`, `edit` and the API with the key (and flag) to fix.
- `edit` replaces the whole `liveness` object: repeat `--liveness-strategy command --liveness-command "<cmd>"` with `--liveness-timeout`.

## Example

```yaml
autoUpdate: false
catchUpInitialDelaySeconds: 300
catchUpStaggerSeconds: 300
onceRetentionDays: 360
onceRetentionMaxJobs: 50
```

## The daemon's own output -- `[stdout]` and `[stderr]`

Under the launcher the daemon has no console, so what it prints used to be lost. It is now copied line by line into the daemon log (`logs/app/daemon-<date>.log`, shown by `orch logs`), tagged `[stdout]` or `[stderr]`: warnings such as a cron schedule that will never fire, a liveness command that timed out, Node's own warnings. Before the log exists the lines go to `logs/daemon/daemon-<date>.log`. In a terminal the output is still printed as before.

## Daemon status

What the daemon says about itself; the config keys it echoes are the ones in the table above.

| Layer | Entry point |
|-------|-------------|
| Daemon RPC | `get-daemon-info` (no payload) |
| HTTP | `GET /api/daemon`, also published by the app-core module; `503 { error: "daemon-not-running" }` when the daemon is down |
| UI | `DaemonStatus` card: footer of the jobs page, and in the app-core dashboard widget |

Reply:

| Field | Meaning |
|-------|---------|
| `version`, `pid`, `port` | The running build, process and RPC port |
| `startedAt` (ISO), `uptimeSeconds` | When this daemon started and for how long |
| `config` | `supervisedJobs`, `lateActionWindowMinutes`, `autoUpdate`, `appCore`, `catchUpInitialDelaySeconds`, `catchUpStaggerSeconds` as read at start |
| `supervisor` | `requested` (`supervisedJobs`), `active` (the executable was found), `note` when requested but not active: the daemon-start warning, with the platform and the fix |
| `runs` | `running` now, how many of them `supervised`, and `followedAgain` (runs this daemon found going and adopted since it started) |
| `scheduler` | `armed` of `desired` timers, and `problems` `[{ jobId, problem }]`. Desired: enabled, not a spent `once`, not `startup`, not `manual`, not past its active period. Same data as `list-timers` |

No job command, environment, `cwd` or secret is in the reply. `/api/health` takes its `uptime` (seconds) from `uptimeSeconds`; it is `null` when the daemon cannot answer `get-daemon-info`, and the rest of the health reply is unaffected.

## Progress and ETA

For a running job the dashboard and `orch status` show a progress percentage and an estimated end time. Advisory only: it never affects running, killing, retrying or alerting.

Strategies are built in and declarative (patterns and JSON only). No external code is loaded and `config.yml` has no plugin setting. Plan: `.claude/plans/2026-10-18_job-progress-and-eta.md`.

### Per-job setting -- `progress`

| Value | Meaning |
|-------|---------|
| absent / `auto` | `declared` (once the log shows `##orch-progress`), then `ensemble`, then `history`; the first that answers wins and the reason lists the skipped ones. The choice is kept for the run, except that `declared` takes over once its lines appear |
| `off` | No estimate; the reason says how to turn it on |
| `<id>` or `{ "strategy": "<id>", "options": {...} }` | Only that strategy; it never falls back to another one |

`ratio` and `log-declared` need a pattern you write, so `auto` never picks them: set them explicitly.

| Id | Options | Example |
|----|---------|---------|
| `history` | none | |
| `declared` | optional `file`: JSON file `{"progress": 0-100, "message"?}`, absolute or relative to the job's `cwd`, at most 64 KB, rewritten by each run | `{"file": "progress.json"}` |
| `ratio` | `pattern` (required, 1 or 2 capture groups: `(\d+)/(\d+)` = done/total, `(\d+)%` = percent), `window` (2-50, default 8: counter values the rate is computed over) | `{"pattern": "(\\d+)/(\\d+)", "window": 8}` |
| `log-declared` | `milestones` (1-30): each `{pattern, at?, weight?}`, in log order; `at` = expected fraction (0-1, increasing) or `weight` = relative step size, on all or none; with neither, positions are learned from past runs | `{"milestones": [{"pattern": "Step 1", "at": 0.3}, {"pattern": "Done", "at": 1}]}` |
| `log-learned` | optional `minSupportPercent` (10-100, default 60): share of usable runs a log line must appear in to count as a milestone | `{"minSupportPercent": 60}` |
| `ensemble` | none | |

What each does:

- `declared`: the job prints `##orch-progress <0..100>[ <message>]` (stdout or stderr) and/or writes the `file`. A value below the last one is ignored; `##orch-progress reset` starts a new phase. The end time is extrapolated from the rate of the last 8 reports, and confidence drops as the last report ages. Opt-in per job: nothing is read unless the job prints the convention or has the option.
- `ratio`: reads the counter from the last 4000 lines of the last 256 KB of the log; a counter that goes down is a reset and starts a new phase (reported in the reason).
- `log-declared`: interpolates between the milestones seen. A pattern that never matched in the past runs is a warning in the reason.
- `log-learned`: masks digits, hex and paths of log lines, keeps the shapes found in at least `minSupportPercent` of the usable runs at a stable relative time (interquartile range of 0.15 of the run or less), and interpolates between the last seen milestone and the next, rescaled by the observed pace. Needs 3 usable runs. A past run has the log format of the open run when they share enough log-line shapes (at least 20% of the open log's first 20 distinct shapes, once it has 2): early lines that vary from run to run do not count as a format change, a log sharing almost nothing does. Only the matching runs are used; with fewer than 3 the reason is `log format changed, relearning (needs N more runs)`.
- `ensemble`: replays `declared`, `log-learned` and `history` on the job's own past runs and uses the one with the lowest ETA error; the reason names the choice and each error. Needs 5 usable runs (3 to answer with `history`) and several polls to finish comparing.

```sh
orch add cron my-job --schedule "0 9 * * *" --command "node script.js" --progress ratio --progress-options '{"pattern":"(\\d+)/(\\d+)"}'
orch edit my-job --progress off
orch edit my-job --progress log-declared --progress-options @milestones.json
orch edit my-job --unset progress                                       # back to auto
```

`--progress` takes `auto`, `off` or a registered id; `--progress-options` takes JSON or `@file` and needs `--progress`. An unknown id or invalid options is refused by `orch add`/`orch edit` with the registered ids or the problem listed. The audit trail names the field (`changes: ["progress"]`), not its options.

Bounds (all strategies):

| What | Limit |
|------|-------|
| Learning | the 20 newest usable runs; logs older than the 20-entry history are used too (their duration comes from the `[job:started]`/`[job:finished]` markers); history wins when both exist |
| Log bytes | 5 MB read per past or current run log; `log-learned`/`ensemble` learn about 1 MB per pass, at the end of a run and then per estimate (the rest on the next ones), `log-declared` scans 4 MB |
| Regex (`ratio`, `log-declared`) | pattern at most 200 characters; no backreference, no nested quantifier such as `(a+)+`, no overlapping alternation under a quantifier, at most 4 unbounded quantifiers; refused when configured |
| Regex at run time | a log line is cut to 2000 characters; a batch of lines has a 500 ms budget (V8 timeout); a pattern that exceeds it is skipped for the next 20 calls and the reason says so |
| Timestamps | log lines carry whole seconds: a run under 10 s gets no `log-learned` estimate (reason says so) |

Files: learned data is in `<configDir>/progress/<jobId>.json` (written atomically, rebuilt from logs and history if lost or corrupt, dropped when the strategy version, the job `command`/`cwd`/`progress` or the log format changes, deleted with the job). Learning (`log-learned`, `ensemble`) runs about 1 s after a successful run ends, off the daemon's request path, once per job however many runs end together; it is idempotent per run, bounded like the lazy path (20 newest usable runs, 1 MB of logs per pass), and a failure is one daemon-log line. A run that ended while the daemon was down is learned lazily by the next `get-progress` of a running job. Saves never block the daemon: the file is written asynchronously (tmp file, then rename; 3 attempts, 100 ms then 200 ms apart on a timer), a reader right after a save sees the new content, and a save that fails for good is logged and skipped (the data is rebuilt from logs and history).

Run logs keep the `[YYYY-MM-DD HH:MM:SS]` prefix and the `[job:started]`/`[job:finished]` markers (written by the daemon's `RunLogger`, including for runs it adopted).

Check which strategy fits a job, offline, over its retained runs (leave-one-out, no look-ahead; reads `registry.json`, `state.json` and the logs, writes nothing):

```sh
orch progress replay <jobId> [--strategy <id>] [--sample-every <percent>] [--json]
```

```
Replay of minutes-stable: 10 usable run(s), a sample every 5% of each run (leave-one-out, no look-ahead)
strategy               cover  MAE s  MAE %  @25%  @50%  @75%  calib  non-monotonic  flips
declared                0.0%      -      -     -     -     -      -              0      0
ratio         not configured      -      -     -     -     -      -              -      -
log-declared  not configured      -      -     -     -     -      -              -      -
log-learned            70.0%    2.1   0.3%  0.5%  0.4%  0.1%  46.6%              0      0
ensemble               70.0%    2.2   0.4%  0.4%  0.4%  0.2%  84.2%              0      0
history                70.0%    4.4   0.7%  0.7%  0.7%  0.7%  28.6%              0      0
Best: log-learned (mean ETA error 0.3% of the run duration, 2.1 s, over 10 run(s))
```

MAE = mean absolute error of the end time; flips = ETA jumps over 20% of the run between two samples; `calib` = calibration, below. All six strategies are listed: `ratio` and `log-declared` as `not configured` (with the `orch edit` command that configures them) until the job has their options, `ensemble` as `n/a` until the job has 5 usable runs. `--json` carries the same per strategy under `metrics` (`calibration`, `calibrated`) and, per sample, `intervalMs` and `inside`. Fewer than 3 usable runs: no table, a verdict saying what to do.

**Calibration.** An estimate states an end time (`etaAt`) and a confidence score s; the interval it states is `etaAt` +- (1 - s) x the predicted duration (for `history`, s = 1 - MAD / median, so the interval is +- the MAD). `calib` is the share of samples whose real end falls inside it (boundary included): a strategy whose score means what it says sits near the coverage that interval implies, far below it means the score is overconfident. Samples with no `etaAt` (overdue) state no interval and are not counted; `-` means none did.

### Where it shows

The audit trail names the field (`changes: ["progress"]`), not its options.

| Layer | Entry point |
|-------|-------------|
| Daemon RPC | `get-progress` `{ jobIds?: string[] }`: one estimate per job with an open run; other jobs are absent. Unknown id or malformed payload: error |
| HTTP | `GET /api/jobs` and `GET /api/jobs/:id` carry `progress`; `GET /api/jobs/:jobId/progress` (also published by the module) answers one estimate, `null` when the job is not running |
| CLI | `orch status` prints `<job>: 42% ~14:32 (low confidence)`, the overdue sentence, or `no estimate - <reason>` |
| UI | `JobProgress`, on the running banner of the job page and on the running job card |

### How `history` estimates


- Usual duration D: median of the last 10 usable runs. Usable: exit code 0, not skipped, not cancelled, not orphaned, no `endReason` (timeout, manual kill, resource limit), has `finishedAt`.
- Fewer than 3 usable runs: no estimate, reason `needs 3 usable runs, has k`.
- `progress` = elapsed / D, capped at 0.99. `etaAt` = start + D.
- Past D: `progress` stays 0.99, `etaAt` is `null`, reason `longer than usual (usual: X)`.
- `confidenceScore` = 1 - MAD / median, clamped to 0..1. `confidence` is `low` under 5 usable runs or a score under 0.5, `medium` under 0.8, else `high`. Low-confidence estimates are shown, marked in the UI.
- `timeoutSeconds: 0` (long-running): no estimate, reason `no completion expected (no timeout)`.
- Several open runs of one job (`maxConcurrency` above 1): one estimate per job, from the oldest open run.

Every estimate carries `reason`; with a null `progress` it says why and what to do. `etaAt` is an absolute ISO time and `serverNow` the daemon clock, so a client counts down without trusting its own clock. When the daemon cannot answer, the HTTP `progress` of a running job is an estimate with `progress: null` and reason `progress unavailable: <message>`.

The 3x anomaly check (`job.anomaly`) is a separate rule: it averages every finished run, failures included. The two do not share a definition of "usual duration".

## Resource monitor

While a job runs, the daemon samples the CPU and RAM of its whole process tree every 2 seconds. From
the job's third successful run on it holds the run to 3 times that baseline (the hard budget) and kills
it once it stays over for 30 seconds (15 consecutive samples). Warning budget (soft): 1.5 times the
baseline. All of this is tunable per job, see "Per-job limits". Everything it sees is in the job's own
log (`orch logs --job <id>`):

```
[resource-monitor] Over hard budget 1/15 (CPU: ... / RAM: 147MB threshold: 130MB)
[resource-monitor] Hard limit exceeded for 15/15 consecutive samples (...) - killing the process tree
[resource-monitor] Process tree at kill: 3 of 4 processes counted; biggest: pid 4242 node.exe (parent 1000) 120MB, ...
[job:finished] exitCode=1 duration=41.2s reason=resource-limit
```

`reason=resource-limit` tells a kill by the monitor from the job failing on its own. The "3 of 4
processes counted" part says how many processes the tree walk offered against how many were attributed
to the job: a process refused as not the job's (it predates the job, or hangs off a recycled pid) is
the difference between a total that is the job's and one that is not.

### Per-job limits -- `resourceLimits`

Optional object on a job; every key is optional, a missing key takes the default. Defaults are more
tolerant than before (2x / 1.2x / 3 samples = 6 s).

| Key | Meaning | Allowed | Default |
|-----|---------|---------|---------|
| `enforce` | What a sustained breach does | `kill`, `warn`, `off` | `kill` |
| `hardFactor` | Hard budget, times the baseline | number > 1 and <= 100 | 3 |
| `softFactor` | Warning budget, times the baseline | number > 1 and < `hardFactor` | 1.5 |
| `sustainSeconds` | How long the hard budget must stay exceeded; samples needed = `ceil(sustainSeconds / 2)` | integer 2-3600 | 30 |
| `maxCpuPct` | Absolute CPU ceiling, replaces the factor-derived hard CPU budget | number > 0 | none |
| `maxRamMb` | Absolute RAM ceiling, replaces the factor-derived hard RAM budget | number > 0 | none |

- Factors need the baseline (3 measured runs). A ceiling does not: with `maxRamMb` set the hard RAM budget exists from the first run. A resource with neither has no hard budget.
- A refused value names the field, the value and the range; `softFactor`/`hardFactor` are compared with the defaults for the one you did not set.
- `enforce: warn`: a sustained breach writes `[resource-monitor] ... would be killed (enforce: warn)` in the job log and publishes `job.resource_hard_limit` with `enforced: false`, once per continuous breach (again after the job went back under). Nothing is killed and the run is not marked `resource-limit`.
- `enforce: off`: no soft or hard threshold is checked. Peaks, telemetry and history are still recorded.
- `job.resource_hard_limit` carries `enforced` (`true` when the run is being killed). `hardThreshold` sides without a definition are `null`.

| Where | How |
|-------|-----|
| CLI | `orch add/edit <id> --resource-enforce kill|warn|off --hard-factor 4 --soft-factor 2 --sustain 60 --max-cpu 150 --max-ram 2048`; an edit changes only the keys given |
| Clear | `orch edit <id> --unset resourceLimits` (all) or `--unset resourceLimits.<key>` (one) |
| Inspect | `orch show <id>` (JSON field `resourceLimits`); also in `get-job`, `list-jobs`, export/import, `edit-job` (`updates.resourceLimits` replaces the whole object) |

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

Every sample is also kept in `<configDir>/telemetry/<jobId>.ndjson`, one JSON object per line. The
dashboard draws it (see below) and an incident can be read after the fact. It is a record only: failing
to write it is reported once in the job's log and never affects the run.

| `kind` | When | Fields besides `t`, `run`, `pid` |
|--------|------|----------------------------------|
| `start` | The run begins | `soft`, `hard`: the `{ cpuPct, ramMb }` thresholds it is held to, or `null` (a side of `hard` is `null` when only the other has a ceiling); `enforce`; `sustainSamples` |
| `sample` | Every 2 s | `cpuPct`, `ramMb`, `walked`, `counted`, and the 5 biggest `processes` (`pid`, `ppid`, `ramMb`, `cpuPct`) |
| `resource-kill` | The monitor decides to kill | `consecutiveSamples`, `cpuPct`, `ramMb` |
| `end` | The run closes | `exitCode`, `durationMs`, `reason` (`timeout`, `manual-kill`, `resource-limit`, absent for an ordinary finish) |

`t` is the time of the line (ISO), `run` the run's `startedAt`, so lines of different runs in the same
file are told apart. The file is rotated at 2 MiB to `<jobId>.1.ndjson`, and only that one older file
is kept: at most about 4 MiB per job. It sits beside the logs but outside the logs folder, because the
log viewer lists a job's runs by file name.

#### Reading it

| Layer | Entry point |
|-------|-------------|
| Daemon RPC | `get-run-telemetry` `{ jobId, run? }` |
| HTTP | `GET /api/jobs/:jobId/telemetry?run=<startedAt>`, also published by the app-core module |
| UI | `RunTelemetry` chart under the run history of the job page; the `Chart` button of a row picks the run (newest by default) |

- `run` is the run's `startedAt`; without it the newest run in the files. `jobId` must be a known job (letters, digits, `-`).
- Answer: `{ run, available, reason?, samples: [{ t, cpuPct, ramMb }], soft, hard, kill?, end?, truncated, bucketSeconds, rawSamples }`.
- `available: false` always carries a `reason` (no file, run rotated away, no sample taken yet).
- At most 600 points: a longer run is bucketed and each point keeps the **max** of its bucket, so a spike survives. `bucketSeconds` is `null` when every point is a raw sample.
- `truncated: true`: the run's `start` line was rotated away, so the chart begins late.
- Retention: 2 MiB per file, one older file (about 4 MiB per job). Older runs are gone: the UI says so.
- Cost: both files are streamed once and only the wanted run's lines are parsed; about 15-25 ms for 4.5 MiB measured on this machine, regardless of where the run sits in the files.
- The chart refreshes every 5 s while the run is going; a finished run is read once.
- The run history marks a peak above the hard budget (the baseline times 3 by default, `GET /api/jobs/:jobId/resource-baseline`); with fewer than 3 measured runs the tooltip says "no budget yet".

### Consumption history

One line per closed run (also killed, timed-out and late-found runs) in `<configDir>/resource-history/<jobId>.ndjson`, kept far longer than the telemetry: the newest 500 per job (the file is rewritten atomically when it grows past that). A write failure is reported once in the run's log and never affects the run. The file is not removed when the job is deleted (same as the telemetry files).

```json
{ "startedAt": "...", "finishedAt": "...", "durationMs": 41200, "exitCode": 0, "endReason": "resource-limit",
  "peakCpuPct": 35.2, "peakRamMb": 410.5, "avgCpuPct": 12.1, "avgRamMb": 188.4, "samples": 20,
  "soft": { "cpuPct": 15, "ramMb": 150 }, "hard": { "cpuPct": 30, "ramMb": 300 }, "enforce": "kill" }
```

- `endReason` is absent for an ordinary end; `exitCode` is `null` for a cancelled run.
- `avgCpuPct`/`avgRamMb`: mean of the samples this daemon took; `null` (and `samples: 0`) when it took none, e.g. a run found already ended after a restart. A run followed again after a restart averages only the samples taken since.
- `soft`/`hard`: the budgets the run was held to, `null` when none existed; a side of `hard` is `null` when undefined. Always `null` for a run found already ended.

| Layer | Entry point |
|-------|-------------|
| Daemon RPC | `get-resource-history` `{ jobId, limit? }`, `limit` a whole number 1-500, default 100 |
| HTTP | `GET /api/jobs/:jobId/resource-history?limit=` |

Answer: `{ runs: [...newest first], total, retention: 500 }`. `total` is the number of runs stored; a job without history answers `{ runs: [], total: 0, retention: 500 }`. An unknown job is refused like `get-run-telemetry`.

## Events pushed to the queue

The daemon pushes events to the `queue` daemon (`POST /push`), so `queue wait <event>` and subscribers in `subscribers.yml` can react. `queue wait` takes an exact event name (`queue wait job.completed --when "payload.jobId=<id>"`; several `--when` must all hold); patterns (`job.*`, `**`) exist only in `subscribers.yml`.

The catalog `packages/orchestrator-cli/src/event-catalog.ts` is the source: for each event, when it fires, its payload schema, an example, its correlation key and whether it ends a run. The daemon declares it to the queue at every start (source `orchestrator`), so read it with `queue events list` and `queue events show <name>`. A test keeps the code, the catalog and this table in step.

The events reach the queue one at a time, in the order they were published: a run's `job.started` is stored before its end event. Tests under `test/events-*.test.js` drive every event through the real scheduler, commands and `orch exec` and check the payloads against the catalog schemas, that each run ends with exactly one terminal event, and what a queue daemon receives.

| Group | Events |
|---|---|
| Run of a job | `job.started`, `job.completed`, `job.failed`, `job.skipped`, `job.killed_manual`, `job.timed_out`, `job.recovered`, `job.anomaly` |
| Requests | `job.triggered_manual`, `job.kill_requested`, `job.restarted` |
| Restart policy | `job.restart_scheduled`, `job.restart_abandoned` (not terminal, they follow the run's end event) |
| Job state | `job.window_expired`, `job.resource_soft_limit`, `job.resource_hard_limit` |
| Alerts | `alert.consecutive_failures`, `alert.retry_exhausted`, `alert.sla_breach` |
| `orch exec` | `exec.started`, `exec.completed`, `exec.failed` |
| Daemon | `daemon.started`, `daemon.restarted` |

A run ends with exactly one of `job.completed`, `job.failed`, `job.skipped`, `job.killed_manual` (the terminal events): `job.timed_out` and a hard resource kill are followed by `job.failed`, `orch kill` produces `job.killed_manual` instead of `job.failed`. `job.kill_requested` is the request, `job.killed_manual` the end of a run. A run the daemon learns about late carries `late: true` and the real `finishedAt`.

Transport is `@wadeck-app/queue-sdk` (finding the daemon, token, `queue start` when it stopped itself, retries, protocol checks); see its `docs/reference.md` and `docs/troubleshooting.md` in the queue repo. Orchestrator decides:

- `cwd`, which selects the project's `.queue/subscribers.yml`: a job's events use the job's `cwd` when it is absolute, every other event (and a job without `cwd`) the orchestrator config dir.
- Failures never block a job. The first failure of a streak is one line in `orch logs` (`[event-publisher] Failed to publish ...`) with the SDK's kind and what to do; the next accepted event logs `Queue delivery recovered`.
- Before stopping (SIGTERM, `/quit`, idle, tray quit and restart) the daemon waits for the pushes in flight, at most 8 s.
- The `queue` CLI must be on `PATH` for events to survive a stopped queue daemon (`not-installed` in the log otherwise).

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
