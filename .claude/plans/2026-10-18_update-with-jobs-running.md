# Updating orch while jobs run

Goal: `orch cli update` / restart works with any job running (long-running or not). A job that
finishes or dies during the restart, and one still alive after it, must give the same information and
features as if orch had not restarted. Nothing app-core specific: a job stays a generic command.

## Facts (verified in code, 2026-10-18)

- `state.closeOrphanedRuns()` closes every open run at start as `orphaned`, without looking at the pid (`state.ts:111`, called `index.ts:214`).
- `Scheduler.stop()` only clears timers; it kills no child (`scheduler.ts:621`).
- Jobs are spawned `shell:true`, stdout/stderr piped to the daemon, not detached (`scheduler.ts:334-379`, `1346`).
- Everything that happens at the end of a run (exit code, `[job:finished]`, events, retry, dependents, peaks flush) hangs off the child's `close` event (`scheduler.ts:1379`).
- Not verified: that `/quit` leaves a half-stopped daemon while pipes are open; whether `npm install -g` hits EBUSY with a job holding files.

## What "same as without a restart" requires

| Feature | Needs |
|---|---|
| Output in the run log | Output must not depend on a pipe to the daemon |
| Exit code, signal, `finishedAt` | Someone observes the end and records it durably |
| Events, retry, dependents, `[job:finished]` | Replayed once, when the end is learned late |
| Timeout | Enforced while the daemon is down, or on its return with the right deadline |
| Resource peaks, hard budget, telemetry | A pid (tree) to sample after the restart |
| Kill (`orch kill`) | A handle to the process tree |
| `maxConcurrency`, liveness skip, "running" in the UI | Running set rebuilt at start |
| Pid reuse safety | Creation time or an owner that vouches for the pid |

## Cases every option must answer

1. Ends normally during the restart.
2. Dies (crash, SIGKILL, OOM) during the restart.
3. Still alive after the restart.
4. Timeout elapses while orch is down.
5. User runs `orch kill` right after the restart.
6. The supervising piece itself dies (if there is one).
7. Machine reboots (all jobs gone, runs must close as interrupted).
8. Pid reused by an unrelated process.

## Options

### A. Adopt by pid
Detach jobs, send output to files, persist `pid + creation time`, at start check the pid and poll it.

- 1/2: exit code unknown (no parent to `wait`), unless a wrapper writes it, which is option C.
- 3: works; sampling and kill use the pid.
- 8: handled by creation time.
- Cost: the most invasive in `scheduler.ts`; exit code is the open hole.

### B. Cooperative files (the job writes progress and touches a heartbeat)
Liveness by heartbeat age, progress read from the job's file.

- Good: no pid ownership, no pid reuse problem, simple to read.
- 1: exit code only if the job writes it; 2: noticed only after the heartbeat goes stale (a delay, and a wrong "alive" window).
- 3: no pid, so no resource sampling, no kill, no peaks, unless a pid is also recorded.
- Only works for jobs that were written for it. `echo`, `npm run x`, a third-party server do nothing of the sort, so most jobs would be a different, lesser class.
- Verdict: good as an optional extra (progress and heartbeat shown in the UI), not as the mechanism.

### C. Supervisor shim (recommended base)
Each job runs as `orch-supervise <runId> -- <command>`: a small detached process that spawns the job,
owns its stdio (to the run log), and writes a status file in the run's folder.

- Status file: `pid`, creation time, `startedAt`, deadline (timeout), `heartbeat` (the shim touches a file every few seconds), and at the end `exitCode`, `signal`, `finishedAt`.
- The daemon never owns the job, so a restart is just "read the run folders":
  - 1: status file has the end: finalize with the real code, replay events/retry/dependents once.
  - 2: same, with the signal. The shim reports it because it is the parent.
  - 3: heartbeat fresh and shim pid alive: re-attach (running set, sampling on the job's pid tree, kill through the shim).
  - 4: the shim enforces the timeout itself, so it fires while orch is down.
  - 5: kill goes to the shim, which kills the tree (the code already in `process-tree.ts`).
  - 6: heartbeat stale and shim pid gone with no end record: run closed as `lost`, tree swept by pid.
  - 7: nothing alive: closed as interrupted (today's behaviour).
  - 8: heartbeat plus creation time vouch for the pid.
- Works for any command, no cooperation.
- Cost: one extra process per running job; a Go binary (the launcher already ships in the platform packages) is a few MB, a node shim is far heavier (inference, not measured). Needs a new subcommand or binary and Windows detach behaviour verified.

### D. C plus the cooperative extras of B
The shim's heartbeat is the user's "touch"; a job may additionally write a progress file that the UI shows. Optional, per job, no impact on the mechanism. Recommended end state.

### E. Do nothing for jobs; mark some as "service" and exclude them
Services survive, orch loses them (no log, no exit code, no peaks). Rejected: it breaks "same info as without a restart".

## Comparison

| | A pid | B coop | C shim | D = C + B extras | E exclude |
|---|---|---|---|---|---|
| Exit code of a job that ended while down | no | only if job writes it | yes | yes | no |
| Works for any command | yes | no | yes | yes | yes |
| Peaks / budget / kill after restart | yes | no | yes | yes | no |
| Timeout enforced while down | no | no | yes | yes | no |
| Pid reuse safe | creation time | n/a | heartbeat + creation time | same | n/a |
| Extra process per job | no | no | yes | yes | no |
| Change size | large | small | large | large + small | small |

## Common work whatever the option

- Extract the end-of-run logic from the `close` handler (`scheduler.ts:1379`) into one function that a late end can call.
- Replace `closeOrphanedRuns` by "adopt or orphan" at start, before `scheduler.start()`.
- `stop` gets a reason: explicit stop kills jobs, update/restart leaves them.
- Output goes to a file the daemon only tails.
- Tests first for the 8 cases, on Windows first (the dev machine), macOS/Linux in CI.

## Open questions

- Accept an extra process per running job (C)?
- Go subcommand in the existing launcher, or a separate tiny binary?
- A job that ended while down: replay retry and dependents, or only record it? (Proposal: replay, flagged `late: true` in the event.)
