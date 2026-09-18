# Remaining work — orchestrator / dsl-view

Continuation plan. Decisions already taken by the user are marked **DECIDED** and must not be
re-litigated.

## Environment facts that cost time today

- **Dev dashboard port is NOT 47951.** 47951 is the user's real dashboard (global install, real
  config). The dev server takes the next free port. Read it from `.dev-config/config.dashboard`
  every time.
- `dev-server.mjs` reuses an existing dev daemon; only `--stop` then start picks up a new bundle.
- `deploy-dev.mjs` now builds orch-ui, orch-app, orch-server, the CLI **and** the CJS bundle. All
  five are required — two separate staleness bugs came from missing steps.
- `deploy-dev --global` exits 2 by design. Only `npm install -g` and `orch cli update` change the
  global install; CI publishes.

## 1. CI verification (do first)

Five orchestrator commits pushed unverified: `eafcdf7`, `94eaa21`, `94e7aeb`, `3ced743`, and
`bd46315`. Two Windows failures earlier today were real regressions of mine, not flakes. Use
`/poll-ci wadeck-app/orchestrator <sha>`.

dsl-view `9389821` (hue tokens) had not published as of the last check — latest was still
`2026.9.18-076-00cba669`. Verify, then bump orchestrator's three package.json files so the terminal
ThemeScope gets the hue tokens.

## 2. Active window in the UI

Daemon and form are done. Missing: the card cannot show the state.

- `NextFireCountdown` should render "Starts in 3 days" for `pending` and "Expires in 5 days" when a
  window is closing, using `msUntilStart` / `msUntilEnd` from `active-window.ts`.
- `JobStatusPill` needs a `pending` kind — **enabled-but-not-yet-started is not disabled**, and the
  pill currently cannot say so.
- `Scheduler.windowStateOf(id)` already exists; the API does not expose it yet. Either surface it on
  `/api/jobs` or derive the state client-side from `activeFrom`/`activeUntil`, which orch-ui's `Job`
  type now carries.

## 3. Past `once` jobs — **DECIDED**

Retention: **configurable, default 360 days / max 50 jobs**, whichever bound hits first.

A spent `once` job is currently removed from the registry, which loses its type — so the audit
cannot distinguish it from a cron run. `job.added` and `job.deleted` now record `type`, which is the
prerequisite.

- Daemon: on firing, mark `spent` + `spentAt` instead of `registry.remove`. Prune by the retention
  bounds.
- Default views exclude spent jobs, so nothing changes visually today.
- A "Past once" filter chip beside All/Cron/Startup/Once/Failed reveals them with their real outcome.
- Run history already survives in `state.json` (removal never purged it), so the outcome is
  available.

## 4. `once` job UX — suggestions accepted, not built

- `NextFireCountdown` returns the bare word "Once", which is the type badge repeated. The CLI shows
  `in 1234s` from `scheduledAt + delayMs`; the dashboard should show at least as much, plus
  "Overdue by X" in `text-warning` when the moment has passed.
- A `once` card shows uptime, streak, five run dots and a Logs link, all meaningless before its
  single run. It needs its own shape.
- The form asks for seconds-from-now. An absolute datetime, converted to `delayMs` on submit, matches
  intent and makes "overdue" legible.

## 5. Test-quality follow-ups

- Convert the remaining real-time scheduler tests to `FakeTime`. The resource-monitor tests still
  sleep, and `job-peaks` allows itself 20 seconds — it failed twice on loaded CI today.
- `sampleIntervalMs` was a workaround for the same problem and can go once those move.

## 6. dsl-view

- Story typechecking is wired into `build` via `tsconfig.stories.json`; tests remain unchecked and
  carry pre-existing type debt, including an intentional `@ts-expect-error`.
- A compact label-less select for toolbars is still missing: the log run selector is a raw `<select>`
  because `PageSizeSelect` is locked to pagination and `FieldSelect` renders a visible label.

## 7. Backlog from the design review

Two hand-rolled tables (`JobCardGrid`, `RunHistory`) to `DataTable`; six duplicated duration
formatters; two spinners; two relative-time implementations; five native `confirm()` to
`ConfirmDialog`; remaining `title=` attributes to `Tooltip`.

## Open question for the user

`CRON_RE` validates cron shape and range, but nothing range-checks a `once` job's `delayMs` upper
bound, and `orch list` clamps an overdue once job to `in 0s` rather than saying it is overdue. Worth
fixing together with item 4.
