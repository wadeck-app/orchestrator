# Changelog

## v3.0.0 (2026-09-05) - In progress

### Added
- Event queue integration: job lifecycle events pushed to queue daemon
- Job tags/labels with color palette
- Per-job environment variables
- Success streak counter on job cards
- Runtime anomaly detection
- Uptime % per job (rolling 30-day)
- Bulk actions (enable/disable/trigger/delete multiple jobs)
- Global stats bar (toggleable)
- Log search with highlight
- `orch run <id>` CLI command
- Job templates with 5 common cron examples
- OS timezone display in Schedule page
- Webhooks config UI with event type checkboxes (NOTIF-01)
- Consecutive-failure alert badge on job cards (NOTIF-02)
- Dark mode with Moon/Sun toggle and localStorage persistence (UX-06)
- Job dependencies: run job B after job A succeeds (SCHED-02)
- SLA window monitoring: alert if job misses completion window (MON-04)
- Secrets storage AES-256-GCM, injected as env vars at spawn (DX-02)
- Dry run mode for scripts declaring dryRunSupported (DX-03)
- Config-as-code YAML watch: sync jobs.yaml to registry (DX-05)
- Blue hourglass systray icon when any job is running (TRAY-02)

## v2.0.0 (2026-09-03)

### Added
- Web dashboard with DSL YAML pages
- Job detail, form, logs, audit, schedule pages
- Linear-inspired navbar
- Failure toast notifications with Acknowledge
- Duration tracking and mini pass/fail history
- Import/export jobs
- Advanced form fields (liveness, onExitCode, timeout)

## v1.0.0 (2026-09-01)

### Added
- Initial web dashboard
- Job list, detail, logs
- Systray integration
- Cron/startup/once job types
