# Orchestrator v3 — Task Tracker

Last updated: 2026-09-05 (EVENT-01 done)

## Legend
- [ ] Not started
- [->] In progress
- [x] Done
- [!] Blocked

---

## Core Architecture

- [x] **EVENT-01** — Event queue integration (push job events to queue daemon on port 47910)
  - Emit: job.started, job.completed, job.failed, job.recovered
  - Integrate with existing queue at C:/Workspace_Tooling/queue
  - _Plan: .claude/plans/2026-09-05_event-queue-integration.md_

- [ ] **NOTIF-01** — Webhook/email notifications via queue subscribers
  - Config: per-job or global webhook URL, SMTP settings
  - Depends on: EVENT-01

- [ ] **NOTIF-02** — Consecutive-failure alert threshold
  - Default: 3 failures → emit alert.consecutive_failures event
  - Visual: badge on job card when threshold exceeded

## Monitoring & Alerting

- [ ] **MON-01** — Success streak counter on job cards
  - Show streak N on each card, reset on any failure

- [ ] **MON-02** — Runtime anomaly detection
  - Alert if job takes 3× longer than rolling average (configurable multiplier)
  - Emit: job.anomaly event to queue

- [ ] **MON-03** — Uptime % per job (rolling 30-day)
  - Computed from non-failing runs / total scheduled runs

- [ ] **MON-04** — SLA window monitoring
  - Flag job if not completed within configurable window after scheduled time

- [ ] **MON-05** — CPU/RAM monitoring per job
  - Monitor resource usage per job PID during execution
  - Document: whether limiting is possible or "resource budget" approach

## Systray

- [ ] **TRAY-01** — Green checkmark flash on job success
  - Similar to existing red error mark, flash green for 5s on success
  - No toast — just the systray icon

## Scheduling & Config

- [ ] **SCHED-01** — Global timezone config (default: OS timezone)
  - Single global setting, affects all cron display and scheduling

- [ ] **SCHED-02** — Job dependencies (B runs after A succeeds)
  - Note: if dependency graphs get complex → "flow" use case (out of scope)
  - See docs/guiding-principles.md

## UX & Dashboard

- [ ] **UX-01** — Job templates / presets with 5 common cron examples
  - Examples: every 10min, every hour, daily at midnight, weekdays 9am, first of month

- [ ] **UX-02** — Tags / labels with colors per job
  - Color picker or predefined palette, filter by tag in job list

- [ ] **UX-03** — Bulk actions (enable/disable/trigger/delete multiple jobs)

- [ ] **UX-04** — Global stats bar (total, running, failed, uptime)
  - Toggleable, disabled by default

- [ ] **UX-05** — Log search within a run
  - Search/highlight in LogViewer

- [ ] **UX-06** — Dark mode
  - Full color system inversion, agent-browser validation required
  - _Plan: .claude/plans/2026-09-05_dark-mode.md_

## Developer Experience

- [ ] **DX-01** — Per-job environment variables
  - Stored in registry.json, passed to spawned process

- [ ] **DX-02** — Secret storage (if not too complex)
  - Encrypted at rest, injected as env vars at runtime

- [ ] **DX-03** — Dry run mode (only for scripts that declare support)
  - Scripts declare `"dryRunSupported": true` in their config
  - Pass `--dry-run` flag when running

- [ ] **DX-04** — `orch run <id>` CLI command
  - Trigger a job from the CLI directly

- [ ] **DX-05** — Config-as-code YAML watch
  - Watch a YAML file for job definitions, auto-sync to registry

## Real-time

- [ ] **RT-01** — WebSocket real-time push (replace SSE polling)
  - Abstract transport layer: SSE, WebSocket, long-poll
  - Reference: C:/Workspace_Other/poc-node and C:/Workspace_Tooling/agent-fleet
  - Full integration test suite required
  - _Plan: .claude/plans/2026-09-05_realtime-transport.md_

## Docs

- [ ] **DOC-01** — Guiding principles doc + out-of-scope boundaries
- [ ] **DOC-02** — Update spec _index.md with v3 decisions

---

## Completed (v2)
- [x] Job list with last run, duration, mini pass/fail dots
- [x] Audit log with Lucide icons
- [x] Schedule timeline (next 24h)
- [x] Import/export jobs
- [x] Advanced form fields (liveness, onExitCode, timeout)
- [x] Linear-inspired navbar
- [x] Failure toast notifications with Acknowledge
- [x] Dark mode (pending validation)
- [x] entriesGenerator auto-discovery
- [x] DSL page system (YAML pages)
