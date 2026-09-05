# Orchestrator v3 — Feature Proposals

Inspired by Prefect, Inngest, Trigger.dev — adapted for a local-first, systray-resident, scraper-management daemon.

---

## Feature List

### F01 — Email / Webhook notifications on failure or recovery
Send a POST to a configurable webhook URL (or email via SMTP) when a job fails or recovers.
Why it fits: scrapers run unattended overnight; silent failures are the main pain point.

### F02 — Consecutive-failure alert threshold
Raise an alert only after N consecutive failures (configurable per job, default 3).
Why it fits: occasional flaky failures are noise; a streak signals a real problem.

### F03 — Success streak counter on job cards
Display a "streak: N" indicator showing runs without a failure.
Why it fits: positive reinforcement and quick health signal without opening logs.

### F04 — Uptime percentage per job (rolling 30-day)
Show a "94.2%" uptime figure derived from non-failing runs over 30 days.
Why it fits: gives a single comparable reliability score across all scrapers.

### F05 — SLA window monitoring
Flag a job if it hasn't completed successfully within a configurable window after its scheduled time.
Why it fits: distinguishes "ran and failed" from "never started" which both look like failures today.

### F06 — Runtime anomaly detection
Alert if a job takes 3× longer than its rolling average (configurable multiplier).
Why it fits: a scraper that normally runs in 30 s but today ran for 20 min is worth investigating.

### F07 — Desktop toast notifications (Windows notification area)
Push a Windows toast on job failure/success from the systray daemon.
Why it fits: the daemon already owns the systray; native notifications are the next natural step.

### F08 — Health-check endpoint GET /api/health
Return JSON with the status of all jobs, suitable for monitoring tools.
Why it fits: allows external uptime monitors (UptimeRobot, etc.) to watch the local daemon.

### F09 — Visual cron expression builder
Replace the raw cron field with a human-readable picker (minute/hour/day dropdowns).
Why it fits: most users don't memorise cron syntax; removes a copy-paste step.

### F10 — Cron next-10-firings preview when editing
Show the next 10 scheduled run times in a tooltip while the user is editing the schedule.
Why it fits: instant validation of a cron expression without needing an external tool.

### F11 — Per-job timezone setting
Store a timezone alongside each job's schedule; display all times in local zone.
Why it fits: currently cron times are UTC, causing confusion for European/Asian users.

### F12 — Monthly calendar view of scheduled jobs
A calendar heatmap showing which days have runs and their outcomes.
Why it fits: provides temporal context that the list view can't show.

### F13 — Job dependencies (run B after A succeeds)
Declare that job B only fires after job A completes with exit 0.
Why it fits: scraper pipelines often have a "scrape then process" two-step pattern.

### F14 — Max concurrent-jobs rate limit
Cap how many jobs run simultaneously (configurable globally and per tag).
Why it fits: 10 scrapers firing at 10:00 simultaneously can saturate bandwidth or CPU.

### F15 — Backfill mode (catch up on missed intervals)
When a job is re-enabled after downtime, optionally run it once per missed interval.
Why it fits: some scrapers need daily data continuity, not just the next scheduled run.

### F16 — Pause until date ("vacation mode")
Temporarily suspend a job until a specific date without disabling it permanently.
Why it fits: avoids having to remember to re-enable suspended jobs after travel.

### F17 — Job templates / presets
One-click create a new job from a built-in or saved template (e.g. "daily scraper at 10:00").
Why it fits: reduces the time to add a new scraper from ~2 minutes to ~20 seconds.

### F18 — Tags / labels per job with filter UI
Attach user-defined tags (e.g. "scraper", "critical", "experimental") and filter by them.
Why it fits: at 10+ jobs, the flat list needs grouping; tags are more flexible than folders.

### F19 — Bulk actions (enable/disable/delete)
Apply an action to multiple selected jobs at once via checkboxes.
Why it fits: managing 20+ scrapers one-by-one is tedious.

### F20 — Job cloning
Duplicate a job with a new ID, inheriting all config.
Why it fits: many scrapers differ only in a parameter (e.g. different target URL or time).

### F21 — Job config version history
Track each edit to a job's config with a timestamp; allow diffing two versions.
Why it fits: "what changed when it started failing?" is a common debugging question.

### F22 — Manual retry with override params
Re-trigger a failed job with a modified command/env, without saving the change permanently.
Why it fits: debugging a failure often means testing a hypothesis without touching the config.

### F23 — Job groups / folders
Nest jobs under named folders (e.g. "Finance scrapers", "Social scrapers").
Why it fits: tag filtering is good but a hierarchy can be more intuitive for large collections.

### F24 — Quick-filter: jobs that failed today
One-click view of all jobs with a failure in the last 24 h.
Why it fits: the first thing to check every morning.

### F25 — Output file viewer (HTML, JSON, CSV inline)
When a job writes a known output file, render it in a panel next to the logs.
Why it fits: scrapers produce files; switching to File Explorer to review them is friction.

### F26 — Diff view for scraper output (previous vs current run)
Highlight what changed in the output compared to the last successful run.
Why it fits: the goal of most scrapers is to detect changes; showing the diff is the main value.

### F27 — Webhook trigger (HTTP POST to start a job)
Expose a per-job endpoint that starts a run when POSTed to.
Why it fits: allows other tools (CI pipelines, n8n, Make) to trigger scrapers on-demand.

### F28 — Discord / Slack notification integration
Post a formatted message to a channel on failure, recovery, or completion.
Why it fits: Discord and Slack are where many solo developers already monitor their systems.

### F29 — Output file retention policy
Keep only the last N outputs per job; delete older ones automatically.
Why it fits: scrapers that run twice daily can accumulate hundreds of files over months.

### F30 — RSS feed of job run events
Expose /api/feed.xml with recent run events, subscribable in any RSS reader.
Why it fits: passive monitoring without polling the dashboard.

### F31 — Export run history to CSV
Download a CSV of all run events with timestamps, exit codes, and durations.
Why it fits: allows ad-hoc analysis in Excel/Sheets without building a query interface.

### F32 — Automation rules (on job event → action)
Define "if job X fails, trigger job Y" or "on success, call webhook Z".
Why it fits: eliminates wiring automation in an external tool for common reactive patterns.

### F33 — orch run <jobId> CLI command
Trigger a job by ID directly from the terminal without opening the dashboard.
Why it fits: developers already live in the terminal; a quick trigger command removes context switch.

### F34 — Config-as-code (watch a YAML file for job definitions)
Define jobs in a `jobs.yaml` file that the daemon watches; edits auto-sync.
Why it fits: version control and code-editor ergonomics for job config management.

### F35 — Per-job environment variables
Set env vars scoped to a single job, passed to the process at spawn time.
Why it fits: scrapers need credentials; polluting the global env is wrong.

### F36 — Secret storage (encrypted env vars in config dir)
Encrypt sensitive values (API keys, passwords) at rest using a machine-derived key.
Why it fits: plain-text secrets in registry.json are a security risk.

### F37 — Dry-run mode
Execute the job command with a DRY_RUN=1 env var and display what it would do.
Why it fits: lets users test new scrapers without triggering side-effects.

### F38 — API key authentication for the dashboard
Protect /api/* endpoints with a configurable API key for remote access scenarios.
Why it fits: the dashboard currently binds to 127.0.0.1; a key enables safe port-forwarding.

### F39 — orch config show / orch config set CLI
Read and write daemon settings (idle timeout, log retention, etc.) from the terminal.
Why it fits: power users prefer CLI over editing JSON files manually.

### F40 — Import/export job definitions between machines
Export all jobs to a portable JSON file and import it on another machine.
Why it fits: setting up a new machine shouldn't require recreating 20 scrapers by hand.

### F41 — Runtime sparkline per job (last 30 runs)
A tiny SVG line chart of runtime duration for the last 30 runs on each job card.
Why it fits: shows performance regression visually without opening the detail page.

### F42 — Gantt timeline of concurrent runs
Show overlapping runs on a horizontal time axis to identify scheduling conflicts.
Why it fits: rate-limiting and dependency planning require seeing concurrent execution.

### F43 — Success-rate heatmap (GitHub contributions style)
A 365-day grid where cell colour encodes daily success rate.
Why it fits: reveals seasonal patterns or long-running reliability trends at a glance.

### F44 — Global stats bar (runs today, failures, avg duration)
A fixed row at the top of the dashboard with 3–4 aggregate metrics.
Why it fits: gives instant situational awareness without reading individual cards.

### F45 — Dark mode support
Toggle between light and dark themes, persisted in localStorage.
Why it fits: many developers run dark-mode systems; the current UI breaks OS-level dark mode.

### F46 — Log search and filtering within a run
Full-text search inside a log viewer with keyword highlight and jump-to-match.
Why it fits: long scraper logs are unreadable without search; grep-in-browser reduces context switches.

### F47 — Side-by-side run comparison
Open two run logs in split view to compare a failing and a passing run.
Why it fits: regression debugging often requires comparing output from two specific runs.

### F48 — Real-time dashboard updates via WebSocket (no polling)
Push run-start, run-complete, and state-change events to the browser over WebSocket.
Why it fits: the current 30 s polling adds latency; WebSocket push makes the dashboard feel live.

### F49 — Inline pass/fail dots for last 10 runs on job cards
A row of 10 coloured dots (green/red/gray) showing the last 10 run outcomes per card.
Why it fits: already partially implemented; extending to 10 and making consistent adds context.

### F50 — Keyboard shortcuts for core actions
Hotkeys for trigger (T), toggle enable/disable (E), open logs (L), navigate (↑↓).
Why it fits: power users with many jobs navigate faster with keys than mouse clicks.

---

## Dollar Vote Panel

Three independent voters each allocate $30 across features ($0–$3 per feature).

### Voter A — Power user (20+ scrapers, reliability and monitoring focus)

| Feature | $ |
|---------|---|
| F01 Email/webhook notify | 3 |
| F02 Consecutive-failure alert | 3 |
| F04 Uptime % | 2 |
| F05 SLA monitoring | 2 |
| F06 Anomaly detection | 1 |
| F07 Desktop toast | 2 |
| F08 Health endpoint | 1 |
| F11 Timezone | 2 |
| F13 Job dependencies | 3 |
| F14 Rate limiting | 2 |
| F15 Backfill | 2 |
| F18 Tags | 1 |
| F19 Bulk actions | 1 |
| F21 Version history | 1 |
| F24 Filter failed today | 1 |
| F26 Diff view | 1 |
| F27 Webhook trigger | 1 |
| **Total** | **30** |

### Voter B — Developer (clean DX, debugging, minimal config)

| Feature | $ |
|---------|---|
| F09 Cron builder | 1 |
| F10 Cron preview | 1 |
| F11 Timezone | 1 |
| F17 Templates | 1 |
| F22 Retry with override | 1 |
| F33 orch run CLI | 3 |
| F34 Config-as-code | 2 |
| F35 Env vars per job | 3 |
| F36 Secrets | 3 |
| F37 Dry run | 3 |
| F38 API key auth | 2 |
| F39 orch config CLI | 1 |
| F40 Import/export | 1 |
| F46 Log search | 2 |
| F47 Run comparison | 1 |
| F48 WebSocket push | 2 |
| F50 Keyboard shortcuts | 2 |
| **Total** | **30** |

### Voter C — Product / UX (polish, notifications, integrations)

| Feature | $ |
|---------|---|
| F01 Email/webhook notify | 3 |
| F07 Desktop toast | 3 |
| F09 Cron builder | 1 |
| F12 Calendar view | 2 |
| F16 Pause until date | 1 |
| F17 Templates | 2 |
| F18 Tags | 2 |
| F19 Bulk actions | 1 |
| F23 Groups/folders | 1 |
| F25 Output file viewer | 1 |
| F28 Discord/Slack | 2 |
| F43 Heatmap | 1 |
| F44 Stats bar | 2 |
| F45 Dark mode | 3 |
| F48 WebSocket push | 2 |
| F49 Inline sparklines | 2 |
| F50 Keyboard shortcuts | 1 |
| **Total** | **30** |

---

## Vote Results — Top 20

| Rank | ID | Feature | Voter A | Voter B | Voter C | Total |
|------|----|---------|---------|---------|---------|-------|
| 1 | F01 | Email / webhook notifications | $3 | $0 | $3 | **$6** |
| 2 | F07 | Desktop toast notifications | $2 | $0 | $3 | **$5** |
| 3 | F48 | WebSocket real-time push | $0 | $2 | $2 | **$4** |
| 4 | F13 | Job dependencies | $3 | $0 | $0 | **$3** |
| 5 | F11 | Per-job timezone | $2 | $1 | $0 | **$3** |
| 6 | F35 | Per-job env vars | $0 | $3 | $0 | **$3** |
| 7 | F36 | Secret storage | $0 | $3 | $0 | **$3** |
| 8 | F37 | Dry run mode | $0 | $3 | $0 | **$3** |
| 9 | F33 | orch run CLI command | $0 | $3 | $0 | **$3** |
| 10 | F45 | Dark mode | $0 | $0 | $3 | **$3** |
| 11 | F17 | Job templates / presets | $0 | $1 | $2 | **$3** |
| 12 | F18 | Tags / labels | $1 | $0 | $2 | **$3** |
| 13 | F50 | Keyboard shortcuts | $0 | $2 | $1 | **$3** |
| 14 | F02 | Consecutive-failure alert | $3 | $0 | $0 | **$3** |
| 15 | F46 | Log search within a run | $0 | $2 | $0 | **$2** |
| 16 | F44 | Global stats bar | $0 | $0 | $2 | **$2** |
| 17 | F49 | Inline pass/fail dots (10 runs) | $0 | $0 | $2 | **$2** |
| 18 | F19 | Bulk actions | $1 | $0 | $1 | **$2** |
| 19 | F14 | Max-concurrent rate limit | $2 | $0 | $0 | **$2** |
| 20 | F34 | Config-as-code (YAML watch) | $0 | $2 | $0 | **$2** |
