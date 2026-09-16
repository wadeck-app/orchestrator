# orch-ui design review

Tracks user-reported UI defects and audit findings. Each item says where the fix belongs:
**dsl-ui** (every consumer benefits) or **orch** (orchestrator-specific).

Measured on the seeded dev server, 1440x900, both themes.

## User-reported

| # | Defect | Measured | Cause | Fix in | Status |
|---|---|---|---|---|---|
| F1 | Action row buttons at different heights | Run now 28px, View logs/Edit 38px, Delete 36px | Two causes, see F1a/F1b | both | partial |
| F1a | 38 vs 36 among dsl-ui buttons | 2px | `secondary`/`danger-outline` carried `border`, other variants did not; variants were setting geometry | dsl-ui | done |
| F1b | 28 vs 36 | 8px | `TriggerButton` is hand-rolled: `px-3 py-1.5 text-xs` instead of a dsl-ui button | orch | todo |
| F2 | Wand icon beside the cron field not aligned | field 38px vs button 32px; top +2px, bottom -4px | Hand-rolled `p-2` button plus an `mb-1` nudge, never reconciled with the field box | orch | todo |
| F3 | Select chevron glued to the right edge | `padding-right: 12px`, `appearance: auto` | Native select keeps the UA-drawn arrow inside the padding; `FieldSelect` has the same defect | dsl-ui | todo |
| F4 | Hand-made components still in use | - | Only whole-component duplicates were replaced; raw `<button>`/`<select>`/`<input>` inside the 28 kept components were never touched | orch | todo |
| F5 | Job search bar too wide | - | Occupies a full page row | orch | todo |
| F6 | Job search inconsistent with the log-page search | - | `LogViewer` has its own input (`w-40`, dark terminal palette) while the job list uses dsl-ui `SearchBar` | both | todo |
| F7 | `CronBuilder` promoted to dsl-ui on weak grounds | 1 real dsl-ui consumer (orch-ui); capability-framework declares `"edge"` but imports it nowhere | Tested coupling, concluded reusability | dsl-ui | accepted as debt, revert offered |
| F8 | Complete design review requested | - | - | - | in progress |
| F9 | Screenshot naming `[feature]-[theme]-[before/after]` | - | - | - | done |

## Decisions

**Variants pick colour, never geometry.** Every `_Button` variant now carries a `border`,
transparent where the design has no outline, so height depends only on `size`.

**Promotion requires a second consumer.** With one real consumer, "will other apps need it"
cannot be answered by observation. Default: a component stays in the app until a second
consumer asks for it. F7 failed this test.

**Terminal surface via scoped tokens, not dark classes.** `LogViewer` hand-rolls
`bg-gray-800`/`text-gray-400` etc. to stay dark in both themes, which is why no dsl-ui
component can be used inside it. Overriding the semantic tokens within the pane instead
lets dsl-ui components render correctly there and removes the whole class of hand-rolled
dark classes. Blocks F6.

## Audit findings

Pending: inventory of raw HTML controls and hand-rolled patterns inside the 28 kept
components, mapped to dsl-ui equivalents.
