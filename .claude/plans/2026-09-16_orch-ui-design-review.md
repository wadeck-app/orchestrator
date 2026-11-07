# Dashboard design review

Only what is still open. Each item says where the fix belongs: **dsl-ui** (every consumer benefits) or **orch** (orchestrator-specific). The user-reported defects F1 (button heights), F2 (cron wand alignment), F3 (select chevron), F5 (filters row) and F6 (log search) are fixed.

## Open

| # | Item | Fix in | State |
|---|---|---|---|
| F4 | Hand-made controls still in use: raw `<button>` / `<select>` / `<input>` inside kept components (`JobForm.tsx`, `FailureBanner.tsx`, `JobCardGrid.tsx`) | orch | open: map each to its dsl-ui equivalent |
| F7 | `CronBuilder` promoted to dsl-ui on weak grounds: one real consumer (this app); capability-framework declares `"edge"` but imports it nowhere | dsl-ui | accepted as debt, revert offered |
| F8 | Complete audit of raw HTML controls and hand-rolled patterns inside the kept components | orch | not done |

## Decisions

**Variants pick colour, never geometry.** Every `_Button` variant carries a `border`, transparent where the design has no outline, so height depends only on `size`.

**Promotion requires a second consumer.** With one real consumer, "will other apps need it" cannot be answered by observation. A component stays in the app until a second consumer asks for it. F7 failed this test.

**Terminal surface via scoped tokens, not dark classes.** `LogViewer` overrides the semantic tokens within the pane (`ThemeScope`) instead of hand-rolling dark classes, so dsl-ui components render correctly inside it.
