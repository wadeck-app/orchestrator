/**
 * The text of `orch --help`, `orch job --help` and `orch job <jobId> logs --help`.
 *
 * Kept out of cli.ts so the tests can read it without running the CLI, and so a line wider than 100
 * columns or a flag the parser accepts but the help forgets is caught by test/help-text.test.js.
 */

import { PROGRESS_STRATEGY_IDS } from './progress/registry.js';

export const HELP_TEXT = `
orch -- cross-platform job orchestrator

Concepts:
  job           A scheduled or startup task with an id, command, and schedule
  cron          Runs on a cron schedule (5-field: min hour day month weekday)
  startup       Runs once when the daemon starts, with optional delay
  once          Runs once after a delay, then is marked as fired (hidden from orch list, see --past)
  manual        Never scheduled: runs only when triggered (orch trigger <id>, dashboard, API)
  liveness      Optional check: if target is already alive, skip firing the job
  execution     One run of a job. Its exec id is the start stamp (e.g. 2026-10-24T08-35-01, UTC)

Usage: orch <command> [options]

Daemon lifecycle:
  orch start                   Start the daemon; tails logs in an interactive TTY
                               (Ctrl+C stops the tail, the daemon keeps running)
                               --no-follow  Return as soon as the daemon is up, without tailing
                               --follow,-f  Tail even when stdout is piped
  orch stop [--kill-jobs]      Stop the daemon. Jobs run under their own supervisor keep running and
                               are followed again at the next start; the jobs named in the answer
                               do.
                               --kill-jobs  End every running job first
  orch restart                 Restart the daemon (not a job: use restart-job <id>)
  orch status [--json]         Show daemon pid, port, uptime. Never starts the daemon: when it is
                               not running, says so and exits 1 (JSON: {"running":false})
                               plus the progress and end time of each running job ("42% ~14:32")
                               JSON fields: pid, port, uptime (seconds), info, progress
  orch install                 Register orchestrator in OS startup
  orch uninstall               Remove from OS startup

Job inspection:
  orch list [--verbose] [--past] [--json]
                               List all jobs; --verbose adds last run + exit code.
                               Past "once" jobs (already fired) are hidden unless
                               --past is given; see onceRetentionDays in config.yml
  orch show <id> [--json]      Show full job detail
                               JSON fields: id, type, label, command, schedule,
                               description (when set), delaySeconds, cwd, enabled,
                               triggerMode, missedFiring, liveness, tags, timeoutSeconds,
                               resourceLimits (when set)
                               (orch list stays one line per job and does not show it;
                               orch list --json carries it)
  orch --pid                   Show daemon pid/port (no daemon required)

Job (sub-commands of one job: orch job <jobId> <sub-command>; all of them: orch job --help):
  orch job <jobId> logs [execId] [-f] [-n <N>] [--list] [--json] [--raw]
                               The log of one execution of the job, as plain text
                               execId           latest (default) | previous | 1, 2, 3... (1 =
                                                latest, 2 = the one before) | an exec id from --list
                               -f, --follow     Stream a running execution until it ends or Ctrl+C;
                                                prints its exit code at the end. A job that is not
                                                running: shows its last execution, says so, exits 0
                               -n, --tail <N>   Only the last N lines (default: all); the cut is
                                                said on stderr
                               --list           The retained executions, newest first: exec id,
                                                start (UTC), exit code or running, duration,
                                                trigger
                               --json           Lines as {t,text} (one array; with -f one object per
                                                line); with --list an array of executions
                               --raw            Keep escape sequences (colour, cursor codes);
                                                stripped by default, see jobsNoColor in
                                                docs/daemon-config.md
                               Reference: orch job <jobId> logs --help
                               Examples:
                                 orch job nightly-backup logs
                                 orch job nightly-backup logs 2026-10-24T08-35-01
                                 orch job nightly-backup logs previous
                                 orch job nightly-backup logs -f
                                 orch job nightly-backup logs --list

Job mutation:
  orch add cron <id> --schedule <expr> --command <cmd> [options]
  orch add startup <id> --command <cmd> [--delay <seconds>] [options]
  orch add --once <id> --delay <duration> --command <cmd> [options]
                               Fire once after <duration> (e.g. 30s, 2m, 1h, 1d), then self-delete
  orch add manual <id> --command <cmd> [options]
                               No --schedule, --delay, --missed-firing or --active-*: a manual job
                               has no schedule
  orch edit <id> [options]     Patches the job: a flag you omit leaves that field as it was
                               --unset <field>[,<field>...]  Clear an option instead of changing it.
                               Repeatable. Fields: cwd, delaySeconds, missedFiring, timeoutSeconds,
                               maxConcurrency, env, tags, onExitCode, retryOnExitCodes, retryDelays,
                               skipExitCodes, liveness, label, triggerMode, description,
                               progress, resourceLimits (resourceLimits.<key> clears one key)
                               Example: orch edit my-job --unset cwd
  orch remove <id>             Remove a job and the data derived from its runs (telemetry, resource
                               history, finished run folders). Its logs stay until age pruning.
                               Files a running instance still writes are reported, not deleted.
  orch enable <id>             Enable a job
  orch disable <id>            Disable a job

Job options (orch add and orch edit read the same table, so nothing is settable by one only;
a flag that is not listed here is refused, not ignored):
  Identity and description
    --command <cmd>              What to run
    --label <text>               Display name (defaults to the id)
    --description <text>         What the job is for: plain text, line breaks allowed, up to 2000
                                 characters (longer is refused, not cut). Documentation only, shown
                                 by the dashboard and by orch show. Clear it with
                                 --unset description
    --cwd <path>                 Working directory
    --tags <a,b>                 Comma-separated tags
    --secrets <A,B>              Secret names to inject as env vars
    --env KEY=VALUE              Repeatable. Split on the first '=' only
    --disabled                   (add) Create the job disabled
    --once                       (add) One-shot job; see "orch add --once" above
  Schedule
    --schedule <expr>            Cron expression (cron jobs)
    --delay <seconds|duration>   Startup delay (startup jobs) or time before firing (once jobs)
    --missed-firing <mode>       catch-up | skip (default: skip)
    --active-for <3w|21d|48h>    Run only for this long, then disable
    --active-from <date>         Start firing at this date (may be future)
    --active-until <date>        Stop firing at this date, then disable
    --liveness-strategy <s>      none | portFile | pidFile | command (default: none), see below
    --liveness-port-file <p>     Port file to read (portFile strategy)
    --liveness-command <c>       Command to run (command strategy)
  Execution
    --trigger-mode <mode>        fire-and-forget | wait (default: fire-and-forget)
    --max-concurrency <n>        Refuse to start a run while n are already running (default: no
                                 limit; 1 = never two at once). A refused run is a skip, not a
                                 failure
    --depends-on <job-id>        Fire this job after <job-id> succeeds
    --alert-after-failures <n>   Alert after n consecutive failures (default: 3)
    --sla-window <minutes>       Alert if no success within the window
    --dry-run-supported          Command accepts --dry-run (clear it with --unset)
    --progress <mode>            How the progress and estimated end of a running job are computed:
                                 auto (default: the first strategy that can answer) | off | an id.
                                 Registered ids:
                                   ${PROGRESS_STRATEGY_IDS.join(', ')}
                                 A named id never falls back to another strategy.
                                 Back to auto: orch edit <id> --unset progress
    --progress-options <json>    Options of the named strategy: a JSON object, or @file.json to read
                                 it from a file. Replaces the whole setting; needs --progress
  Timeouts
    --timeout <seconds>          Kill the run after this long (default: 300; 0 = no timeout,
                                 for a process that must stay up, e.g. a dev server)
  Retry and skip
    --retry-on-exit-codes <c>    Exit codes that trigger a retry; see "Retry on failure" below
    --retry-delays <seconds>     Delay before each retry; see "Retry on failure" below
    --skip-exit-codes <c>        Exit codes meaning "nothing was done"; see "Exit codes that are not
                                 failures" below
    --on-exit-code CODE=MESSAGE  Repeatable. Systray message for an exit code
  Resource limits
    Per job, stored as resourceLimits and shown by orch show. The monitor compares a run with the
    mean of the job's last 10 successful peaks (the baseline, needs 3 runs); a run that stays over
    the hard budget for --sustain seconds is acted on. Each edit changes only the keys you give.
    --resource-enforce <mode>    kill | warn | off (default: kill). warn: log the breach and publish
                                 job.resource_hard_limit with enforced=false, kill nothing. off: no
                                 threshold checked
    --hard-factor <x>            Hard budget = x times the baseline (default: 3; greater than 1, at
                                 most 100)
    --soft-factor <x>            Warning budget = x times the baseline (default: 1.5; greater than
                                 1, below --hard-factor)
    --sustain <seconds>          How long the hard budget must stay exceeded (default: 30; whole
                                 number 2-3600)
    --max-cpu <pct>              Absolute CPU ceiling, replaces the hard CPU budget; needs no
                                 baseline
    --max-ram <mb>               Absolute RAM ceiling, replaces the hard RAM budget; needs no
                                 baseline
    Clear them with: orch edit <id> --unset resourceLimits
    (or --unset resourceLimits.<key>, e.g. resourceLimits.maxRamMb)
  Output
    --json                       Print the result as JSON

Schedule format (cron jobs): standard 5-field cron -- min hour day month weekday
  Examples: "*/5 * * * *"   every 5 minutes
            "0 9 * * 1-5"   9 AM on weekdays
            "30 8 * * *"    8:30 AM daily

Liveness strategies (skip firing if target is already alive):
  none       Always fire -- no liveness check (default)
  portFile   Read <portFile>, check if its PID is alive -> skip if alive
  pidFile    Find PID file by job id -> skip if PID is alive
  command    Run <command> -> skip if it exits 0

Manual execution:
  orch trigger <id> [--wait] [--force] [--json]
                               Fire a job immediately. A job at its --max-concurrency is not
                               started (reported, exit 0); --force starts another instance anyway
  orch kill <id>               Stop a job that is currently running
  orch terminate <id>          Alias for kill, for shells that block the word
  orch restart-job <id> [--json]
                               End every running instance of the job, wait until it is gone, then
                               start it again; a job that was not running is simply started. Meant
                               for a long-running job (--timeout 0, a process that must stay up) but
                               accepts any job. Exit 1, with the reason and the fix, when nothing
                               was started (liveness check still says alive, at --max-concurrency,
                               the old instance would not end). Not "orch
                               restart", which restarts the daemon
  orch exec "<cmd>" [--wait]   Run a one-shot command via the daemon (for agent delegation)

Dashboard:
  orch server start            Start the web dashboard server (opens browser)
  orch server stop             Stop the web dashboard server
  orch server status           Show dashboard server status and URL

Systray automation:
  orch tray list               List all triggerable tray actions
  orch tray <action>           Trigger a tray action (same as clicking it)

Retry on failure:
  --retry-on-exit-codes <codes>  Comma-separated exit codes that trigger retry, e.g. 3
  --retry-delays <seconds>       Comma-separated delays in seconds, e.g. 300,600,1800,5400
  Hooks: configure onJobRetry / onJobExhausted in ~/.config/orchestrator/hooks.json

Exit codes that are not failures:
  --skip-exit-codes <codes>      Comma-separated exit codes meaning "nothing was done", e.g. 2
                                 The run is recorded as skipped: no failure, no retry, no alert,
                                 no systray badge, and it neither helps nor hurts the uptime figure
                                 Per job on purpose -- what a code means belongs to the program
                                 being run. The @wadeck-app scrapers use 2 for "another instance is
                                 already running"; another binary may use 2 for a real fault
                                 Example: orch edit wa-scrape --skip-exit-codes 2

  A skip also happens without any exit code when the job has a liveness check and the target is
  already alive -- see --liveness-strategy above.

Logs:
  orch job <jobId> logs [execId] [-f]
                               The log of one job: see "Job" above. Prefer it for any job
  orch logs [--follow] [--job <id>] [--tail <N>] [--json] [--raw]
                               Read today's orchestrator or job log file
                               (for a job, prefer: orch job <jobId> logs [execId] [-f])
                               --follow     Tail log in real-time (Ctrl+C to stop)
                               --job <id>   Show logs for specific job (default: daemon logs)
                               --tail <N>   Show last N lines (default: all)
                               --json       Output as JSON (timestamp + message per line)
                               --raw        Keep escape sequences (colour, cursor codes); stripped
                                            by default

Global flags:
  --json                       Force JSON output
  --version                    Print version and exit
  --pid                        Print daemon pid/port and exit
  --help                       Show this help

Internal (used by auto-updater, not for general use):
  orch cli self-check          Validate bundle integrity; exit 0=ok, 1=fail

Exit codes: 0=ok  1=error  2=daemon-not-running  3=not-found  4=validation-error

Other commands:
  setup-task                Install a daily Windows Scheduled Task (twice daily)
  remove-task               Remove the scheduled task

Progress (estimated progress and end of a running job; configure it per job with --progress):
  orch progress replay <jobId> [--strategy <id>] [--sample-every <percent>] [--json]
                               How well each strategy would have estimated the job's past
                               runs: replays the retained successful runs one by one, using only
                               the runs before each (no look-ahead), and prints per strategy the
                               mean error of the estimated end (seconds and % of the duration,
                               at 25/50/75% elapsed), how often it had an estimate, progress
                               going backwards and end times jumping by more than 20%. Names
                               the best strategy. Needs 3 successful runs; reads the files of
                               the config dir, the daemon is not needed
                               --strategy <id>  Only this strategy (default: declared,
                                                log-learned, history and the job's own)
                               --sample-every   Sample every N percent of a run, 1-50 (default 5)

Environment variables:
  ORCH_CONFIG_DIR         Config directory (default: ~/.config/orchestrator)
  ORCH_UPDATE_INTERVAL    Background update interval (default: 4h)
`.trim();

export const JOB_HELP = `
orch job -- the sub-commands of one job

Usage: orch job <jobId> <sub-command> [options]

  <jobId>      The id of an existing job, as shown by: orch list

Sub-commands:
  logs         Read the log of one execution of the job, or follow it
               orch job <jobId> logs [execId] [-f] [-n <N>] [--list] [--json] [--raw]
               Reference: orch job <jobId> logs --help

Examples:
  orch job nightly-backup logs
  orch job nightly-backup logs -f
  orch job nightly-backup logs --list

Exit codes: 0=ok  1=job or execution not found / no log yet  4=usage error (this text is printed
on stderr)
`.trim();

export const JOB_LOGS_HELP = `
orch job <jobId> logs -- the log of one execution of a job

Usage: orch job <jobId> logs [execId] [-f|--follow] [-n|--tail <N>] [--list] [--json] [--raw]

  <jobId>      The id of an existing job, as shown by: orch list
  [execId]     Which execution to read, see "Choosing the execution". Default: latest

Choosing the execution
  latest         The newest execution (default)
  previous       The execution before the latest
  1, 2, 3...     Counting back: 1 = latest, 2 = the one before (= previous), 3 = the one before that
  <exec id>      The execution itself: its start stamp (UTC) exactly as in the log file name and as
                 --list prints it, e.g. 2026-10-24T08-35-01. 2026-10-24 08:35:01 is accepted too
  --list         Do not read a log: list the retained executions, newest first, with the exec id to
                 copy, the start (UTC), the exit code or "running", the duration and the trigger.
                 Cannot be combined with an execId, -f or -n

Following
  -f, --follow   Print the end of the log, then keep streaming new lines of the running execution
                 until it ends or Ctrl+C. When it ends, the last line is
                 "[orch] run ended with exit code N" and the exit code of orch is 0
                 If the execution is not running (finished, or not the one in progress), nothing is
                 awaited: the log is printed, "the job is not running; showing the last run" is said
                 on stderr, and orch exits 0. It never waits for a future execution

Output
  -n, --tail <N>   Only the last N lines (N is a whole number of 1 or more; default: all). The
                   lines cut are counted on stderr: "N earlier lines not shown"
  --json           Lines as {t,text} objects (t = the [YYYY-MM-DD HH:MM:SS] stamp, null when a
                   line has none): one array for a snapshot; with -f one object per line,
                   ending with {"event":"run-ended","exitCode":N}.
                   With --list: an array of executions (execId, startedAt, status, exitCode,
                   durationMs, trigger)
  --raw            Print the lines byte for byte. By default the escape sequences (colour, cursor
                   codes) are stripped from what is printed. Jobs are started with NO_COLOR=1 and
                   FORCE_COLOR=0 (jobsNoColor in docs/daemon-config.md); orch adds no colour of its
                   own, so the output is plain text when piped

Errors and exit codes
  0   Printed (including -f on a job that is not running, and -f that followed to the end)
  1   Unknown job (run: orch list) | the job has no log yet (run: orch trigger <jobId>) | no
      execution matches the execId (run: orch job <jobId> logs --list)
  4   Usage error: missing jobId, unknown flag, a flag without its value, -n that is not a whole
      number of 1 or more, an execId that is none of the forms above, --list with an execId,
      -f or -n

Examples
  orch job nightly-backup logs                         The latest execution, whole
  orch job nightly-backup logs 2026-10-24T08-35-01     One execution, by its exec id
  orch job nightly-backup logs previous                The execution before the latest
  orch job nightly-backup logs -n 50                   The last 50 lines of the latest
  orch job nightly-backup logs -f                      Follow the running execution
  orch job nightly-backup logs --list                  The retained executions
`.trim();
