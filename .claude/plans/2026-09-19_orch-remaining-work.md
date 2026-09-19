# Remaining work — orchestrator

Continuation plan. **DECIDED** marks a choice the user has already made: implement it, do not re-open it.

State at the time of writing: `fb162ed` on main, CI green on three OS, published and installed globally
as `2026.9.19-354-fb162ed4`, 629 tests passing.

## Environment facts

- **The dev dashboard port is not fixed.** Read `.dev-config/config.dashboard`. It took 47951 today
  only because the user's real dashboard was not listening.
- `dev-server.mjs` reuses a running dev daemon; `--stop` then start is required to pick up a new bundle.
- `deploy-dev.mjs` builds orch-ui, orch-app, orch-server, the CLI and the CJS bundle. All five.
- Only `orch cli update` moves the global install. `deploy-dev --global` exits 2 by design.
- **Another session works in this same working tree.** Run `git diff <path>` before `git add <path>`:
  a commit here already swept up a peer's in-flight refactor.
- Guardrails block `rm`, `kill`, inline `node -e`, python, and git commit/push without a two-step
  bypass. Heredocs trip the commit guard — write the message to a file and use `git commit -F`.

## 1. Past `once` jobs — **DONE**

Retention **configurable, default 360 days / max 50 jobs**, whichever bound hits first.

Shipped:

- `spent` + `spentAt` on `Job`; `registry.markSpent(id)` replaces `registry.remove` in `_scheduleOnce`
  (both the overdue and the timer path) and in `trigger`.
- `Registry(file, { onceRetentionDays, onceRetentionMaxJobs, now })`, pruning on `markSpent` and on
  `load()` — the age bound passes with time rather than with an event, so a daemon that was off for a
  year must not serve an unbounded backlog.
- `_scheduleOnce` returns early on a spent job; `_timerProblem` returns null for one. Without the
  second, `orch timers` said "enabled but NOTHING is armed" about every job that had run.
- `TimerReport.spent`, so `orch timers` distinguishes "finished" from "never scheduled".
- `orch list` hides spent jobs, `--past` shows them, and the hidden count is printed with the flag.
  Filtered before the JSON branch, so an agent sees the same default view.
- "Past once" chip in `JobFilterChips`; `JobCardGrid` excludes spent jobs from every other filter;
  `NavBar` stats exclude them too (they were counted in "8 jobs" while the grid showed four).
- `spent`/`spentAt` are daemon-owned: `orch edit --unset spent` says so instead of "Unknown job field".
- `config.yml` gained `onceRetentionDays` / `onceRetentionMaxJobs`, and `loadDaemonConfig` now takes an
  `onWarn` sink — a value it cannot parse is reported with line, value and fallback instead of becoming
  NaN in silence. Unknown keys are reported. This fixed the pre-existing hole on the catch-up keys too.

Live-verified on the dev instance: a once job fired, went `spent: true` / `problem: null`, the count
bound pruned to the configured 4, and both config warnings reached the daemon log.

Left for item 3: a spent card still shows the bare word "Once", a five-dot streak and uptime.

## 2. Active window in the job card

The daemon, the form and `orch timers` all carry it; the card cannot show it.

- `NextFireCountdown`: "Starts in 3 days" / "Expires in 5 days" from `msUntilStart` / `msUntilEnd`.
- `JobStatusPill` needs a `pending` kind — enabled-but-not-yet-started is not disabled.
- Data is available without new daemon work: `inspectTimers` returns `windowState`, `dueAt` and
  `windowEndsAt`, and orch-ui's `Job` already carries `activeFrom` / `activeUntil`.

## 3. `once` job UX

- `NextFireCountdown` returns the bare word "Once", which repeats the type badge. `onceScheduleDisplay`
  in the CLI already produces "in 3h" / "overdue by 5m" — reuse that wording.
- A `once` card shows uptime, streak, five run dots and a Logs link, all meaningless before its single
  run. It needs its own shape.
- The form asks for seconds-from-now; an absolute datetime converted to `delayMs` on submit matches
  intent and makes "overdue" legible.

## 4. Stale dashboard pidfile

`~/.config/orchestrator/config.dashboard` names pid 77244 from 2026-09-18T20:37; that process is gone
and nothing cleaned the file. `classifyDashboard` in `dashboard-pidfile.ts` exists for exactly this, so
either nothing calls it on this path or it is not wired to the daemon's startup. Handed to session
orchestrator-11 — check with them before starting.

## 5. dsl-view

- A compact label-less select for toolbars is still missing: the log run selector is a raw `<select>`
  because `PageSizeSelect` is locked to pagination and `FieldSelect` renders a visible label.
- Story typechecking is wired into `build`; tests remain unchecked and carry pre-existing type debt.

## 6. Design backlog

Two hand-rolled tables (`JobCardGrid`, `RunHistory`) to `DataTable`; six duplicated duration
formatters; two spinners; two relative-time implementations; five native `confirm()` to `ConfirmDialog`;
remaining `title=` attributes to `Tooltip`.

## Lessons from this session

Each of these cost real time today and would be repeated by a fresh context.

- **Research the platform before designing around it.** A whole design rested on "timers under-count
  suspend". Windows `QueryPerformanceCounter` counts sleep (Microsoft documents it) and macOS uses
  `mach_continuous_time` for that exact reason (libuv `4685be2`); only Linux `CLOCK_MONOTONIC` does not,
  and there is no Linux package here. The sources are recorded on `MAX_TIMER_CHUNK_MS`.
- **A fake more capable than the real thing hides bugs.** `FakeTime` did not clamp delays above
  2^31-1 ms, so three timing bugs sat under a green suite. It clamps now.
- **Do not assert a budget against the knob under test.** A lateness test advanced by exactly
  `MAX_TIMER_CHUNK_MS` and asserted lateness `<= MAX_TIMER_CHUNK_MS`, which passes at any value. State
  the promise in product terms instead.
- **Separate the user's constraint from the implementation's.** `delayMs` has no upper bound: a timer's
  ceiling is the scheduler's problem, absorbed by `waitUntil`.
- **Tests that bypass validation test nothing users can reach.** Two liveness tests armed a six-field
  cron the registry has always refused.
- **A test that throws before its teardown hangs the file instead of failing.** Use `try/finally`
  around anything that arms a timer or spawns a process.
- **Check `problem` in `orch timers` first when a job does not fire.** It compares the registry against
  what is armed, which is where every such bug in this project has lived.
