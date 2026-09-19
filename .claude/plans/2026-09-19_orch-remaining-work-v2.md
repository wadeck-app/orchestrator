# Remaining work -- orchestrator (v2)

Supersedes `2026-09-19_orch-remaining-work.md`, whose items 1-4 and half of 5 are done.
**DECIDED** marks a choice already made: implement it, do not re-open it.

## State

| | |
|---|---|
| orchestrator HEAD | `c591b40`, CI green on three OS + publish |
| published CLI | `2026.9.19-376-61788a72` |
| published dsl-ui / dsl-renderer | `2026.9.19-080-964f4490` (from `C:\Workspace_Tooling\dsl-view`) |
| tests | 681 CLI, 296 orch-ui, 233 orch-app, 60 orch-server |
| violations | orchestrator 3 (none from this work), dsl-view 252 |

## Done, for context

| Item | Commits |
|---|---|
| 1. Past `once` jobs retained, not deleted | `0648ef6` |
| One lessons file per project | `f96cfa3` |
| 2+3. Active window in the card, once-job card shape | `152f239` (message describes only the other half; see `d7ac208`) |
| 3. Once form takes an absolute moment | `43287e0` |
| 4. Daemon clears a stale `config.dashboard` | `bc9b8eb` |
| 5a. `CompactSelect` + log run selector | `964f449` (dsl-view), `83b81ac` |
| 6a. Five native `confirm()` to `ConfirmDialog` | `61788a7` |
| 1. Bulk actions did nothing in the dashboard | `5bfaff9` |
| 2. `ConfirmDialog` seen in a browser | (verification only, in `5bfaff9`) |
| Resource-monitor skip guard disarmed by one stalled walk | `c591b40` |

## Contention -- read first

Another session (`orch-owner1`) works in this same tree and is running a violations pass.

- Run `git diff <path>` before `git add <path>`.
- **`git commit -F <msg>` with no pathspec commits the whole index**, including another session's
  staged files. Always `git commit -F <msg> -- <paths>`. This already produced one mixed commit
  (`152f239`).
- Never leave files staged across a pause (a bypass dialog counts).

## ~~1. Bulk delete does nothing in the dashboard~~ -- DONE `5bfaff9`

Confirmed and fixed. `job-list.yaml` declared four `$outputs` and no bulk brains while
`registry-overrides.ts` injected eight callbacks, so all four bulk actions published into a namespace
nothing read. The overrides now inject only declared events; `JobCardGrid` asks before delegating; a
new `onAfterBulk` output reloads the job source instead of leaving deleted cards up for 30s.

**The note about `onKill` was wrong.** All three `Running*Detail` variants already `ask()` first and
then call `onKill`, which is the correct layering -- the kill confirmations were never dead. Delete in
those variants is also fine: the visible button sets `confirmDelete`, and `handleDelete` is only
reachable from "Yes, delete".

A bulk action cannot be one `$http` brain -- a brain takes a single URL -- so the fan-out has to stay
in the component. That is why `onAfterBulk` exists rather than four bulk brains.

## ~~2. `ConfirmDialog` is test-verified only~~ -- DONE

Seen rendering in a real browser on the dev dashboard: styled, in-app, dimmed backdrop, Cancel +
Delete. Confirming actually removed the job from the registry and the grid refreshed within ~3s.
`agent-browser` worked this time; the first `open` call takes >180s and looks hung, but the session is
live afterwards -- snapshot it rather than retrying `open`.

## ~~3. dsl-view: tests are not typechecked~~ -- DONE `0d335ac` (dsl-view)

`tsconfig.tests.json` in both packages, wired into `build`. 29 errors surfaced, 3 of them real:
`DataTable.test.tsx` passed `actionsVisible`, a prop DataTable has never had (and one case asserted
the absence of a class it never emits, so it could not fail); `IconButton.test.tsx` had its
`@ts-expect-error` on the `it(` line instead of the JSX. The rest were interfaces where
`T extends Record<string, unknown>` needs a type alias, plus missing node types.

## ~~4. Design backlog~~ -- DONE `cb19839`, `d9065a4`, dsl-view `5722299`

| Item | Outcome |
|---|---|
| Two tables to `DataTable` | Both migrated. Selection stayed in `JobCardGrid` -- DataTable's is internal-only, so handing it over splits the bulk UI per view mode. Select-all moved to the toolbar (`TableColumn.label` is a string). |
| Four `formatDuration` | Three were identical -> `formatElapsed`. RunHistory's was never a duplicate -> renamed `formatFinishedDuration`. |
| Two `alert()` | `notify` on the existing `useConfirm`, one dialog slot per component. |
| Two spinners | dsl-ui `Spinner`, which has the role and accessible name the raw divs lacked. |
| Relative-time | All three consolidated. ScheduleTimeline needed `describeMoment(..., { precise: true })` to keep "in 3h 20m". |

`onRowClick` had to be added to dsl-ui's DataTable: `navigateTo` needs a RouterContext orch-app does
not mount, so a migrated row click would have been silently dead.

## Found while doing the above

- **A failed kill was reported as a success** on every job-detail variant (`cb19839`). `killNow` cast
  the synchronous `publishOutput` to a promise, so control always reached `setJustKilled`.
- **The resource-monitor skip guard was disarmed by its own escape hatch** (`c591b40`).

## Still open

Nothing from this plan. Every item is closed above.

Two things a reader should know rather than rediscover:

- **`d9065a4` bumped root `package.json` to dsl-ui `-082` alongside another session's
  `violations-rules` devDependency.** The lockfile is shared and could not be split. Verified fine:
  `npm ci` runs in CI and passed on `d9065a4` and every push since. The root had to be bumped too --
  with CalVer prereleases `^...-080` is an effective pin, so leaving it would have disagreed with the
  workspaces.
- **Consolidating relative-time changed two visible strings.** The audit log reads "112m ago" where it
  used to read "1h ago", because `formatApproxDuration` only switches to hours at 2h; and a past
  firing on the schedule page reads "overdue by 5m" instead of "now". Both are the shared module's
  documented behaviour, now applied uniformly, which was the point.

## Verification done, so it need not be repeated

Browser-checked on the dev dashboard, not just unit-tested: the confirm dialog, a bulk delete
reaching the registry and the grid refreshing at once, bulk disable/enable from the migrated list
view, a row click navigating through `onRowClick`, both migrated tables with every column, the
schedule page keeping "in 14h 11m", the audit page, and a blocked kill leaving the banner up and
raising an error toast.

`violations check` is at 0 -- but measured against another session's in-flight rule set, which has
three local rules deleted. Re-run once that lands.

## Environment facts

- **The dev dashboard port is not fixed.** Read `.dev-config/config.dashboard`.
- The dev dashboard idles out after ~10 min (P-3). A blank page in the browser usually means it is
  gone, not that the code broke -- check `curl -s -o /dev/null -w "%{http_code}"` first.
- `deploy-dev.mjs` builds all five packages and bundles. **`npm run bundle` alone bundles whatever
  `dist/` already holds**, so after `tsc --noEmit` it silently ships stale code. Use `deploy-dev.mjs`.
- `dev-server.mjs` reuses a running dev daemon; `--stop` then start to pick up a new bundle.
- Only `orch cli update` moves the global install. `deploy-dev --global` exits 2 by design.
- Guardrails block `rm`, `kill`, inline `node -e`, python, and git commit/push without a two-step
  bypass. Heredocs trip the commit guard -- write the message to a file and `git commit -F`.
- Guardrail false positives: the words `unlink` and `kill` inside a `grep` pattern trip the
  destructive-operation guard. Use the Grep tool instead.
- Commit messages: subject, why, any non-obvious constraint. Nothing else. Earlier ones in this
  history are far too long and are not the model to copy.

## Lessons

- **`tsc --noEmit` emits nothing.** Verifying a daemon change needs a real build before the bundle.
- **A suppression comment can be wrong.** The log run selector's said the terminal palette was
  incompatible with the design system; the classes were semantic tokens and the pane was already in a
  `ThemeScope`. Read the code, not the excuse.
- **`FieldWrapper` wires labels by cloning `{id, aria-*}` onto its first child**, which reaches
  nothing unless the child declares those props. That shipped three date fields with a visible label
  and no accessible name. Fixed in dsl-ui `cfb7d01`; the same trap applies to any new field.
- **Name a DSL-settable accessible label `ariaLabel`, not `aria-label`** -- the entries generator
  skips `aria-*` props, so the DOM spelling is unreachable from YAML.
- **A DSL `$output` override makes the component's own handler dead code.** Check
  `registry-overrides.ts` before changing a handler and believing the dashboard will use it.
- **Unquoted `test/**/*.test.js` degrades to `test/*` with globstar off** -- green on two of three
  platforms while running one file. Fixed in `d696d75`; do not group tests into subdirectories
  without re-checking.
- **`pidtree(pid, {root: true})` on a just-spawned pid can return unrelated pids**, because a dead
  pid is reused immediately. Anything enumerating a tree right after spawn may be handed strangers.
- **`scheduler.ts`'s resource monitor uses raw `Date.now()`** for `samplingSince` and `peakFlushedAt`
  while its timer goes through `this._time.every()`. Extending `FakeTime` into the monitor will
  misbehave until those two are injected.
- **Poll CI after every push**, including one that only touches docs. `f96cfa3` was pushed unpolled
  and was red.
- **The resource monitor's skip guard was disarmed by its own escape hatch**, because `.finally`
  cleared `samplingSince` unconditionally and the overtaken walk cleared its successor's marker. Fixed
  in `c591b40` with a per-walk id. This was the Windows-only flake in "a sample is skipped while the
  previous one is still in flight" -- a real bug, not host noise. 10 green runs then red on an
  unrelated commit; do not write a CI failure off as flake without forcing the condition locally.
- **A DSL `$output` override must filter on what the node declares.** Injecting a callback the page
  never declared removes the component's own behaviour instead of adding one. See
  `registry-overrides.test.tsx`.
