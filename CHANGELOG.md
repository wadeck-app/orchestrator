# Changelog

## Unreleased

### Added
- `orch kill <id>` stops a running job from the CLI, with `orch terminate` as an alias for
  shells whose guardrails block the word `kill`. The daemon and dashboard already had it.
- `orch start --no-follow` returns as soon as the daemon answers instead of tailing logs.
  Both paths now confirm readiness before exiting, so a script no longer races startup.

### Fixed
- Start-at-login on Windows. The registry entry ran the launcher from its platform package,
  which then looked for its bundle beside its own exe. `nodeScript` is now a package specifier
  the launcher resolves by walking up node_modules, so it works whether npm hoists or nests.
- The Go launcher could never be built on macOS: `build.sh` clobbered the exported `TMPDIR`,
  making Go ignore the generated `go.mod` as sitting in the system temp root.
- Auto-update rolled back every upgrade: the self-check command was unquoted (breaking on a
  default Windows node path) and never verified the native binaries, so an install whose
  platform package was skipped passed the gate and then could not start.
- The daemon, CLI and tray reported a stale version, because the bundle inlined
  `package.json` before the release version was set.

### Changed
- `startDaemon` requires the Go launcher and fails with an actionable message. The wscript.exe
  and plain-node fallbacks are gone: both produced a daemon with no supervisor, which never
  restarted itself after an update and said nothing.
- Platform packages are republished only when the native binary hash changes, and the main
  package pins them exactly.
- CI runs `build-and-test` on ubuntu, windows and macos, and executes the orch-server,
  orch-ui, orchestrator-cli and Go launcher suites. The first three had never run.

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
