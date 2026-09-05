# @wadeck-app/orchestrator-cli

Cross-platform job orchestrator daemon and CLI - schedules cron, startup, and one-shot jobs, auto-restarts the daemon on update, and serves an optional web dashboard.

## Install

```sh
npm install -g @wadeck-app/orchestrator-cli
```

Requires Node >= 22.

## Usage

### Daemon lifecycle

| Command | Description |
|---------|-------------|
| `orch start` | Start the daemon (idempotent) |
| `orch stop` | Stop the daemon |
| `orch restart` | Restart the daemon |
| `orch status` | Show daemon pid, port, uptime |
| `orch install` | Register orchestrator in OS startup |
| `orch uninstall` | Remove from OS startup |

### Job management

| Command | Description |
|---------|-------------|
| `orch list [--verbose]` | List all jobs |
| `orch show <id>` | Show full job detail |
| `orch add cron <id> --schedule <expr> --command <cmd>` | Add a cron job |
| `orch add startup <id> --command <cmd> [--delay <s>]` | Add a startup job |
| `orch add --once <id> --delay <duration> --command <cmd>` | Fire once after duration (e.g. `30s`, `2m`), then self-delete |
| `orch remove <id>` | Remove a job |
| `orch enable <id>` / `orch disable <id>` | Enable or disable a job |
| `orch edit <id> [--schedule ...] [--command ...] ...` | Edit job fields |
| `orch trigger <id> [--wait]` | Fire a job immediately |

### Dashboard

| Command | Description |
|---------|-------------|
| `orch server start` | Start the web dashboard (opens browser) |
| `orch server stop` | Stop the dashboard server |
| `orch server status` | Show dashboard URL and health |

### Logs

```sh
orch logs [--follow]
```

### Global flags

| Flag | Description |
|------|-------------|
| `--json` | Force JSON output |
| `--version` | Print version and exit |
| `--pid` | Print daemon pid/port and exit |
| `--help` | Show help |

**Exit codes:** `0`=ok, `1`=error, `2`=daemon-not-running, `3`=not-found, `4`=validation-error.

## Configuration

| Item | Default |
|------|---------|
| Config directory | `~/.config/orchestrator` |
| `ORCH_CONFIG_DIR` | Override config directory |
| `ORCH_UPDATE_INTERVAL` | Background update interval (default: `4h`) |

The daemon auto-starts when you run a command that needs it (ssh-agent pattern); no manual `orch start` required on first use.

## Update

The background updater checks GitHub Packages every `ORCH_UPDATE_INTERVAL` (default 4h) and applies updates silently. The next CLI invocation prints the update result to stderr. Run `orch cli update` to trigger a foreground update check immediately.
