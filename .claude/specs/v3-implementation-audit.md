# v3 Implementation Audit — Feedback vs Reality

Generated: 2026-09-05

## Issues Found

| # | Severity | Item | User said | What happened |
|---|----------|------|-----------|---------------|
| 1 | **CRITICAL** | DX-05 config-as-code | Round 1: "not needed but easy so yes"; Round 2: "not needed" (clear reversal) | Implemented AND still on disk (`config-watcher.ts` exists). Revert agent running but file still present. |
| 2 | **HIGH** | F08 health endpoint | "great, but keep it hidden behind a 'builder' button" | Not implemented at all — no builder mode, no health endpoint UI. |
| 3 | **HIGH** | MON-05 CPU/RAM monitoring | "add CPU/RAM monitoring per job; analyse if limiting is possible; resource budget approach" | Not implemented. Not in todo, not in any source file. Completely skipped. |
| 4 | **MEDIUM** | Dark mode agent-browser validation | "careful with colors + agent-browser validation" | Dark mode was deployed; parent session took a screenshot but did NOT run a systematic contrast check (just one visual pass). User is now reporting label colors too light — confirms validation was insufficient. |
| 5 | **MEDIUM** | Stats bar | "advanced disabled in a sense" (implied: off by default, power feature) | Implemented as toggleable bar below navbar — but now being moved inline to navbar. Original ask was "disabled by default", which was honored, but the separate-bar placement was not discussed. |
| 6 | **LOW** | F50 keyboard shortcuts | "not needed" | Correctly NOT implemented. ✓ |
| 7 | **LOW** | RT-01 WebSocket | "great idea, separate plan, full integration tests" | Plan created, not implemented. ✓ correct deferral. |

## Features correctly implemented

- EVENT-01 queue integration ✓
- NOTIF-01 webhooks UI ✓
- NOTIF-02 consecutive failures ✓
- MON-01 streak ✓, MON-02 anomaly ✓, MON-03 uptime ✓, MON-04 SLA ✓
- TRAY-01 green flash ✓, TRAY-02 blue running icon ✓
- UX-01..05 ✓, UX-06 dark mode (partially — colors need fix) ✓
- SCHED-01 timezone ✓, SCHED-02 dependencies ✓
- DX-01 env vars ✓, DX-02 secrets ✓, DX-03 dry run (with dryRunSupported flag) ✓, DX-04 orch run ✓

## Required actions

1. **Complete DX-05 revert** — delete `config-watcher.ts`, remove from `index.ts`/`commands.ts`/routes, mark `[!] rejected` in todo.
2. **Implement MON-05** — CPU/RAM monitoring per job PID + resource budget analysis doc.
3. **Implement F08 health endpoint** — hidden behind a "builder" toggle button in UI.
4. **Fix dark mode contrast** — badge/label colors inadequate (user confirmed). Use agent-browser systematic check.
