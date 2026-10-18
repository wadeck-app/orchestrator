# Plan: job progress and estimated end time

Status: draft, nothing implemented. Spec-first (guiding-principles.md): the open questions in section 9 must be answered before phase 1 starts.

## Decisions (proposed)

- The engine is a pure function of files on disk: run history + per-run log files + job config. It holds no pipe and no in-memory run state, so it survives a daemon restart and the planned per-job supervisor.
- It lives in `packages/orchestrator-cli` (new `src/progress/`), exposed by one new RPC `get-progress`; orch-server only proxies it (P-6: no source import between the two).
- Strategies are plugins behind one interface; `progress: auto` is the default and picks one, with a visible reason.
- Every "no estimate" and every fallback carries a reason string shown to the user. No silent `null`.
- Progress is advisory and never affects job execution, kill, retry or alerting (P-1, P-8: orch does not model what a job did; a strategy only reads what the job chose to write).

## 1. Goal and non-goals

Goal: for a running job, show progress (0..100 %) and an estimated end time with a confidence level, per job, configurable, extensible.

Non-goals:
- No change to how jobs are spawned or logged (the supervisor change is separate; this plan only depends on its output files).
- No alerting or killing based on the estimate (the existing 3x anomaly check at `scheduler.ts:1444-1448` stays as is).
- No understanding of job internals beyond declared patterns (P-8).
- No UI for authoring plugins; plugins are files/packages installed by the user.

## 2. Verified facts the plan builds on

| Topic | Fact | Source |
|---|---|---|
| Run history | `RuntimeEntry`: `startedAt`, `finishedAt?`, `exitCode`, `pid`, `skipped?`, `cancelledByUser?`, `orphaned?`, `retryAttempt?`, `triggeredBy?` | `orchestrator-cli/src/types.ts:210-243` |
| History depth | `MAX_HISTORY = 20` entries per job, newest first, updated in place by `startedAt` | `state.ts:5`, `state.ts:148-162` |
| Duration today | `getRollingAvgDurationMs`: last 10 runs with `exitCode !== null && finishedAt`, needs >= 3, includes failures | `state.ts:272-285` |
| Existing outlier rule | Anomaly if duration > 3x rolling avg (success only) | `scheduler.ts:1444-1448` |
| Run classification | `isFailure` excludes skipped; killed/orphaned runs have `exitCode: null` | `state.ts:14-16`, `scheduler.ts:1393-1398`, `state.ts:111-130` |
| Log location | `<configDir>/logs/jobs/<jobId>/<jobId>-<YYYY-MM-DDTHH-MM-SS>.log`, one file per run, name from `startedAt` (UTC, colons replaced, seconds resolution) | `scheduler.ts:1132-1136`, `logger.ts:20-23` |
| Log line format | `[YYYY-MM-DD HH:MM:SS] <text>` (UTC, 1 s resolution); stdout trimmed and empty lines dropped; stderr prefixed `[stderr] ` | `logger.ts:35-37`, `scheduler.ts:1346-1357` |
| Log markers | `[job:started] pid=.. triggeredBy=..` first; `[job:finished] exitCode=.. duration=..s [reason=..]` or `[job:skipped]` last | `scheduler.ts:1166`, `scheduler.ts:1418-1420` |
| Log retention | pruned when age > 120 days, or > 100 files and age > 30 days; so logs can outlive the 20 history entries | `logger.ts:7-9`, `logger.ts:60-73` |
| Log listing | `listLogFiles` already matches per-run and legacy daily names (`<id>-YYYY-MM-DD.log`); legacy daily files are not per-run and must be ignored by the engine | `orch-server/src/routes/logs.ts:16-29` |
| Log tailing | existing SSE route polls file size every 500 ms and reads from the last offset | `logs.ts:116-156` |
| Telemetry | `<configDir>/telemetry/<jobId>.ndjson`, one rotation only (2 MB), samples every 2 s with `run` = startedAt; has `start`/`end` events with `durationMs` | `job-telemetry.ts:15-28`, `job-telemetry.ts:10`, `scheduler.ts:1417` |
| Events | `EventPublisher.publish` posts to an external queue at `localhost:47910`, fire-and-forget; it is not a channel to the dashboard | `event-publisher.ts:4-20` |
| Dashboard live data | `GET /api/jobs` returns `{job, runHistory, uptimePercent}`; `get-uptime` failure is swallowed to `{}` | `orch-server/src/routes/jobs.ts:50-64` |
| SSE | `/api/events` pushes the whole `list-state` every 5 s; it is NOT in the module's allowed routes | `routes/events.ts:13-34`, `app-module-orchestrator/src/routes.ts:3-13` |
| Pages | job list polls `GET /api/jobs` every 30 s; job detail polls `GET /api/jobs/{id}` every 30 s | `orch-app/src/dsl/pages/job-list.yaml:7-10`, `job-detail.yaml:3-8` |
| UI | `JobCard` uses dsl-ui `Progress` for uptime (inline, sm) and shows the status pill; `RunningBannerDetail` already ticks every 1 s and shows `formatElapsed` | `orch-ui/src/components/JobCard.tsx:286-296`, `RunningBannerDetail.tsx:53-59,140` |
| Job config validation | `validateJob(job)` is the single place a new `Job` field is checked; `UNSETTABLE_FIELDS` must list every new optional field (comment at `types.ts:121-124`) | `registry.ts:29`, `types.ts:126-146` |
| app-core module | reuses orch-server `jobsRoutes`/`logsRoutes` verbatim; pages are derived textually from orch-app YAML; a route must be added to `ALLOWED_ROUTES` to be published | `app-module-orchestrator/src/backend.ts:25-33`, `derivePages.ts:25-60`, `routes.ts:14-36` |
| orch-ui types | orch-ui has its own `RuntimeEntry`/`Job` copy (no `orphaned`, no `retryAttempt`) | `orch-ui/src/types.ts:11,127-145` |

Unknown (to verify before building): the supervisor's log/status file names and whether it keeps the `[job:started]`/`[job:finished]` markers and the `[ts]` prefix; whether `Progress` in dsl-ui supports an indeterminate state; whether a DSL `$sources` poll interval can change while a job runs; where `docs/daemon-config.md` expects new job keys documented.

## 3. Strategies

Common definitions. "Usable run" = in history or log dir, `exitCode === 0`, not `skipped`, not `cancelledByUser`, not `orphaned`, with `finishedAt`. Failed, killed and orphaned runs never feed duration learning (they stop early and would pull estimates down); they may be shown in the replay report.

| Id | Name | Inputs | Progress and ETA | First run (no history) | Outliers, failed, killed | Input-size variance | Confidence | Cost |
|---|---|---|---|---|---|---|---|---|
| `history` (S1) | Duration history | usable run durations (state) | progress = elapsed / D, ETA = start + D, D = median of last N usable durations (N default 10); capped at 0.99 while running; once elapsed > D, progress holds at 0.99 and ETA is "overdue" | `null` + reason "needs 3 usable runs, has 0" | median + MAD trimming drops outliers; failed/killed excluded | none: wide spread lowers confidence | 1 - (MAD / median), clamped; low if < 3 runs | O(N), reads state only |
| `log-learned` (S2) | Learned log milestones | usable runs' log files, current log tail | milestones = log "shapes" (line with digits/hex/paths masked) found in >= K% of usable runs at a stable relative time; progress = piecewise-linear interpolation between the last seen milestone and the next expected one, using each one's median relative time | `null` + reason "no usable run log yet"; falls through to `history` only through `auto` | masked-line stats use usable runs only; a milestone whose relative time varies too much (IQR > threshold) is dropped | milestone times scale with the run: the next-milestone gap is rescaled by the elapsed/expected ratio of the last two milestones | stability of retained milestones + match coverage of the current log | reads up to N log files once per format version; live cost is a tail read (offset-based) |
| `log-declared` (S3) | User milestones | job config: ordered list of `{pattern, at?, weight?}` (regex), current log | like S2 but milestones come from config; `at` = expected fraction, else derived from `weight` (cumulative) or from history timing of the first match; interpolation between matches | works from run 1 if every milestone has `at` or `weight`; otherwise needs history for timing | a pattern that never matched in usable runs is reported as a config warning | same rescaling as S2 | high when `at` is given and observed run times agree | regex per new log line; patterns validated at config time |
| `declared` | Job-emitted progress | log lines `##orch-progress <0..100>[ <message>]` or a JSON file `<cwd>/.orch-progress.json` (path in config) | progress = last value; ETA = extrapolate from the last N reports (rate) or `history` D when rate is unstable | works from run 1 | ignores non-monotonic drops below the last value unless the job resets explicitly; a run that exits non-zero keeps its last value in the record | exact, the job knows | high while reports are recent; drops with report staleness | tail read; file stat |
| `ratio` | Counter extraction | regex with 1-2 groups on the log (`(\d+)/(\d+)`, `(\d+)%`) | progress = a/b or p/100; ETA = rate extrapolation over a sliding window | works from run 1 | reset detection (counter goes down) starts a new phase and is reported | exact when the total is printed | window rate variance | tail read + regex |
| `resource` | Resource signature | telemetry samples of usable runs (cpu/ram) | aligns the current sample series against past usable series (dynamic time warping on normalized time) to get a phase estimate | `null` + reason | telemetry keeps only 2 files (about 2 runs) so it needs a retention change first; excluded in v1 | weak | low by default | CPU heavy, rejected for v1 |
| `ensemble` | Composite | the other strategies' outputs + their replayed accuracy | picks the strategy with the lowest mean absolute ETA error on this job's replayed history, or blends by inverse-error weights; always returns the chosen strategy ids in `reason` | falls back by documented priority order | inherits | inherits | derived from replay error, not from the members' self-report | replay at learn time, cached |

`resource` is listed for completeness; proposed out of v1 (telemetry retention is the blocker, section 9).

## 4. Plugin contract

```ts
// packages/orchestrator-cli/src/progress/types.ts
export interface ProgressContext {
  job: Job;                       // config incl. job.progress options
  run: { startedAt: string; pid: number | null };  // the open run being estimated
  history: ReadonlyArray<RuntimeEntry>;            // newest first, max 20 (state.ts:5)
  logs: LogCorpus;                // see below
  now(): Date;                    // injected clock (tests, replay)
  options: unknown;               // validated plugin options from job.progress
  store: StrategyStore;           // read/write learned data for this job + strategy
}
export interface LogCorpus {
  currentRun(): LogReader;                       // tail since a byte offset, never a pipe
  pastRuns(limit: number): Array<{ entry: RuntimeEntry; reader: LogReader }>;
}
export interface LogReader {
  readFrom(offset: number): { lines: Array<{ ts: Date; text: string }>; nextOffset: number };
  fingerprint(): string;          // hash of first N masked lines, for format-change detection
}
export interface ProgressEstimate {
  strategyId: string;
  progress: number | null;        // 0..1
  etaAt: string | null;           // ISO, absolute (UI interpolates between polls)
  confidence: 'high' | 'medium' | 'low' | 'none';
  confidenceScore: number;        // 0..1
  reason: string;                 // always set, human-readable, actionable
  detail?: Record<string, unknown>;  // e.g. last milestone, rate
}
export interface ProgressStrategy {
  readonly id: string;            // [a-z0-9-]+ (same rule as job ids)
  readonly version: number;       // bump invalidates stored learned data
  validateOptions(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  learn?(ctx: Omit<ProgressContext, 'run'>): Promise<void>;   // after a run finishes; idempotent
  estimate(ctx: ProgressContext): ProgressEstimate;            // sync, cheap, no network
}
```

Rules:
- `estimate` is pure over its inputs and `store`; no timers, no process state.
- A plugin that throws, times out (budget 200 ms) or returns out-of-range values yields `{progress: null, confidence: 'none', reason: "plugin <id> failed: <message>; fix or set progress: history"}`. It is logged to the daemon log; it never aborts `get-progress` for other jobs.
- Registration: built-ins in `src/progress/registry.ts`; external plugins are listed in `config.yml` (`progress.plugins: [<npm package or absolute path>]`), loaded at daemon start; a plugin that fails to load is an error line at startup and in `orch status`, not skipped silently. Plugin security: plugins run in the daemon with its privileges, so loading is opt-in per path (T-model entry to add in `.claude/threat-model.md`).
- Job config key `progress` (added to `Job`, validated in `registry.ts:validateJob`, added to `UNSETTABLE_FIELDS` as `'delete'`, so absent = `auto`):
  - `"auto"` (default), `"off"`, `"<strategyId>"`, or `{ strategy: "<id>", options: {...} }`.
  - Unknown id: rejected at `orch add/edit` with the list of registered ids.
  - CLI: `orch add ... --progress log-declared --progress-options file.json` (exact flags: open question).
- `auto` algorithm (deterministic, documented):
  1. Candidates in priority order: `declared`, `ratio` (only if the job opted in with options), `log-declared` (only if configured), `ensemble`/`log-learned`, `history`.
  2. A candidate is eligible when its `estimate` returns `confidence !== 'none'`.
  3. Choose the first eligible; the result is `reason: "auto: <id> (<why>); skipped <id2>: <reason2>, <id3>: <reason3>"`.
  4. If none is eligible: `progress: null`, `confidence: 'none'`, reason lists every skip reason and the next action ("run the job 2 more times", "add --progress ...").
  5. The chosen strategy is sticky within a run (no flipping mid-run); it is re-chosen at the next run start. Stickiness is recorded in the estimate's `detail.chosenAt`.
- An explicit `progress: <id>` never falls back: if that strategy has no estimate, the user sees its reason, not another strategy's number.

## 5. Data model additions

Learned data is derived, rebuildable, and never edited by hand. Raw truth stays in logs and history.

| Item | Location | Content |
|---|---|---|
| Learned strategy data | `<configDir>/progress/<jobId>.json` (atomic write via `fsUtil.atomicWriteJson`, as `state.ts:78`) | `{ schema, jobId, strategies: { <id>: { strategyVersion, logFingerprint, learnedFromRuns: [startedAt...], data } } }` |
| Per-run replay record | same file, `runs[]` capped at 20 | `{ startedAt, durationMs, outcome, estimateErrors }` for accuracy tracking |
| Job config | `registry.json` job field `progress` | see section 4 |
| Global config | `config.yml` keys `progress.enabled`, `progress.plugins`, `progress.minRuns` (document in `docs/daemon-config.md`) | |

Invalidation rules (each logs a line `[progress] job <id>: dropped learned <strategy> data: <reason>`):
- `strategyVersion` differs from the plugin's `version`.
- `logFingerprint` of the last usable run differs from the stored one in more than T% of masked lines (the job's log format changed): relearn from the usable runs that still match the new fingerprint; below `minRuns`, report "log format changed, relearning (needs N more runs)".
- `command`, `cwd` or `progress` options changed (edit event) -> drop.
- Job removed -> delete the file with the job (hook next to the existing `state.clear`, `state.ts:337-343`); orphan files are cleaned at daemon start.
- File unreadable/corrupt -> rebuild from logs and history, with a startup warning; never block `get-progress`.
- Learning is idempotent per `startedAt`, so it can run both on `job-finished` (`scheduler.ts:1423` emits it) and lazily at estimate time, which covers a daemon that was down when the run ended and the supervisor case where nobody saw the exit.

Run-to-log matching: a run's log is `<jobId>-<startedAt.replace(/:/g,'-').slice(0,19)>.log` (`logger.ts:22`). Two runs starting within the same second collide on the name (existing behaviour; unknown how the supervisor names files).

Data source for durations after the supervisor lands: `finishedAt - startedAt` from history when present; otherwise the status file's exit time; otherwise the `[job:finished]` log line; the chosen source is part of `detail`.

## 6. API and UI

API:
- New daemon RPC `get-progress` (`types.ts` `OrchestratorCommands`, handler next to `get-uptime` at `commands.ts:214`): payload `{ jobIds?: string[] }`, returns `Record<jobId, ProgressEstimate | null>` for jobs with an open run only.
- `GET /api/jobs` and `GET /api/jobs/:id` (`jobs.ts:50-75`) gain `progress: ProgressEstimate | null`. If the RPC fails the field is `{strategyId: null, progress: null, confidence: 'none', reason: "progress unavailable: <message>"}`, not `{}` as `get-uptime` is swallowed today (`jobs.ts:55`).
- New `GET /api/jobs/:id/progress` for a faster poll on the detail page; add it to `ALLOWED_ROUTES` (`app-module-orchestrator/src/routes.ts`), otherwise the module will not publish it.
- Time: the response carries `etaAt` (absolute) and `serverNow`; the client computes remaining time locally so the 30 s page poll (`job-detail.yaml:8`) is enough for the list; the detail page needs a 5 s source (or the existing 1 s UI tick in `RunningBannerDetail.tsx:53-59` with a 5 s refetch while running) - unknown whether the DSL can vary the poll interval.
- Changing `/api/events` is not planned (not published by the module).

UI (`packages/orch-ui`, consumed by `orch-app` YAML pages; the module derives its pages from the same YAML, so no module-specific page code):
- New `JobProgress` component: `Progress` bar + text `"42% - ends ~14:32 (in 6 min)"`; shown in `RunningBannerDetail` (under the elapsed line, `RunningBannerDetail.tsx:140`) and in `JobCard` for running jobs (next to the status pill, `JobCard.tsx:203-206`).
- Low confidence: bar rendered striped/lighter, ETA prefixed `~`, tooltip shows `reason` and strategy id.
- No estimate (`progress: null`): no bar; one muted line with the `reason` (for example "needs 3 completed runs, has 1"), never a blank.
- Overdue (elapsed > expected): text "longer than usual (usual: 12 min)", no negative time.
- Detail page shows a "Progress" row in `JobConfigDisplay` with the configured mode (`auto` or the strategy) and, for `auto`, the chosen strategy and skip reasons.
- orch-ui keeps its own type copy (`orch-ui/src/types.ts`), so the new type is added there too; a contract test compares both shapes.
- Job form (`JobForm.tsx`): a Progress section (mode select + options JSON for advanced strategies); shown errors come from `validateJob`.
- Tray/CLI: `orch status` prints `42% ~14:32` per running job (small, same RPC); tray unchanged in v1.

## 7. Testing strategy (TDD, red then green per phase)

Rules: tests first, committed failing; test the installed `orch` for the end-to-end checks (guiding-principles); no test may silently skip when a fixture is missing - it throws.

- Unit: each strategy against synthetic histories and fixture log files in `packages/orchestrator-cli/test/progress/fixtures/<case>/` (history.json + `logs/*.log` in the real `[ts] text` format from `logger.ts:35-37`).
- Edge matrix per strategy: 0 runs, 1, 2, exactly `minRuns`; all runs identical; one huge outlier; failed/killed/orphaned/skipped runs mixed in; log format change mid-history; empty log; clock skew (log ts earlier than `startedAt`); two runs same second; legacy daily log file present.
- Contract tests (run against every registered plugin, built-in or external): never throws, `progress` in [0,1] or null, `reason` non-empty when `progress` is null, `etaAt >= now` or flagged overdue, deterministic for the same input, completes under the 200 ms budget with 20 logs of 5 MB.
- Replay harness (`orch progress replay <jobId> [--strategy id]`, also a test helper): for each usable past run, truncates the log at sampled elapsed times (every 5% of duration), asks the strategy for an estimate using only the runs older than that run (leave-one-out, no look-ahead), and records absolute error of `etaAt` versus real `finishedAt`.
  - Metrics: MAE of ETA (seconds and as % of duration), MAE at 25/50/75% elapsed, calibration (share of real end times inside the stated confidence interval), monotonicity violations of `progress`, "ETA flips" (changes > 20% between consecutive samples).
  - Gate thresholds are proposed in phases below, set after the first real data (open question).
- Corpus: anonymized real logs from this machine's jobs are copied into `test/progress/fixtures` only with the user's approval (logs may contain secrets; open question).
- Integration: `get-progress` over the daemon RPC with a temp config dir, daemon restart mid-run (engine answers from disk with no re-learn), `GET /api/jobs` shape through `routes.test.ts` style tests, module backend test (`backend.test.ts` style) that the new route is published.
- UI: component tests for each state (estimate, low confidence, none, overdue, error), same style as `JobCard.test.tsx`.
- Accuracy regression: CI runs the replay on the fixture corpus and fails if MAE worsens by more than a set margin.

## 8. Phased delivery

| Phase | Scope | Gate (must be green) |
|---|---|---|
| 0 | Spec answers (section 9); verify the supervisor file contract; add the plugin types and `get-progress` RPC returning `null` + reason "no strategy" | contract test suite exists and passes for a stub plugin; RPC test over daemon with restart |
| 1 | `history` (S1), `auto` with only that candidate, `JobProgress` UI states, `progress` job key (`validateJob`, `UNSETTABLE_FIELDS`, CLI flag), `GET /api/jobs` field, `orch status` line | S1 edge-matrix tests; replay harness MAE reported on fixtures; UI state tests; installed-`orch` manual check on a real job |
| 2 | `log-learned` (S2): masking, milestone mining, interpolation, store file, fingerprint invalidation, learn-on-finish + lazy learn; `auto` order updated | replay shows S2 not worse than S1 on the fixtures it applies to, and `auto` picks S1 where S2 is not better; log-format-change test; learn survives daemon restart |
| 3 | `log-declared` (S3), `declared`, `ratio`; config validation warnings for never-matching patterns | config validation tests; fixtures for each; user-visible warning test |
| 4 | Plugin loading from `config.yml`, external-plugin contract test kit, `ensemble`; threat-model entry | a sample external plugin passes the kit; load failure surfaces in `orch status`; ensemble beats the best single strategy or equals it on the corpus |
| Later | `resource` strategy (needs telemetry retention change), tray display, per-step ETA | separate spec |

## 9. Risks and open questions (not decided here)

Questions for the user:
1. Supervisor contract: file names, whether `[job:started]`/`[job:finished]` and the `[YYYY-MM-DD HH:MM:SS]` prefix remain, who writes the finish time. Phase 0 depends on it.
2. Where should the engine run: in the daemon (this plan) or computed by orch-server from files (the module's `logsRoutes` already receives `configDir`)? The first keeps one implementation and P-6; the second avoids new RPC load on the daemon.
3. Is a job allowed to write `##orch-progress` lines / a progress file (a job-side convention that mildly conflicts with "orch takes the program at its word", P-8, though it only reads what the job volunteers)?
4. Learning depth: history is 20 runs (`state.ts:5`) but logs can reach 100 files; may the engine learn from log files older than history (needs duration from the log's markers)?
5. Telemetry retention (2 files, `job-telemetry.ts:10`) blocks `resource`; is a retention increase acceptable, or is `resource` dropped?
6. Plugins: allowed to execute arbitrary code in the daemon (opt-in via `config.yml`), or must they be declarative (patterns/JSON only) for v1?
7. Default aggressiveness of `auto`: show a low-confidence estimate with a `~` or show nothing below a confidence floor?
8. Can real job logs be copied into the test corpus (secrets risk), or must fixtures be synthetic only?
9. Which jobs matter first (names), so the replay corpus covers real shapes: short (< 10 s, 1 s log resolution is too coarse), long, input-dependent?
10. CLI flag naming for `progress` options, and whether `orch edit --unset progress` is the only way back to `auto`.

Risks:
- Log timestamps have 1 s resolution (`logger.ts:36`): jobs shorter than about 10 s get no useful interpolation; S2/S3 should declare a minimum duration and say so in `reason`.
- Stdout buffering by the job (block-buffered when piped) delays log lines and makes milestones late; undetectable from outside, only mitigated by confidence from replay.
- Jobs with unbounded duration (`timeoutSeconds: 0`, `types.ts:52-55`) have no meaningful ETA; `reason` must say "no completion expected".
- Parallel runs (`maxConcurrency` > 1, `types.ts:65`): one estimate per open run, not per job; the API must key by `startedAt` (the field in the payload above is per job in v1: decision needed, folds into question 2's design).
- Sticky `auto` choice and learned data can drift silently; the replay report and the `reason` string are the controls.
- Learning cost on large logs (up to 100 files): bounded by a byte cap per file and by learning only the 20 newest usable runs; confirm with measurements in phase 2.
- Two copies of the types in orch-ui and orchestrator-cli can diverge (they already differ: `orphaned`, `retryAttempt`); mitigated by the contract test in section 6.
- Side effects found while reading, worth a separate decision: the existing anomaly check (`scheduler.ts:1444`) and the new engine will both define "usual duration"; they should share one function to avoid two different medians/averages.
