# @wadeck-app/orchestrator-cli

Cross-platform job orchestrator daemon and CLI - schedules cron, startup, and one-shot jobs, auto-restarts the daemon on update, and serves an optional web dashboard.

## Install

```sh
npm install -g @wadeck-app/orchestrator-cli
```

Requires Node >= 22.

## Quick start

```sh
orch start                                      # start daemon
orch add cron my-job --schedule "0 9 * * *" --command "node script.js"
orch list                                       # view jobs
orch server start                               # open web dashboard
```

## Commands

- **Daemon:** `orch start` / `stop` / `restart` / `status` / `install` / `uninstall`
- **Jobs:** `orch list` / `show <id>` / `add cron|startup <id>` / `remove` / `enable` / `disable` / `edit` / `trigger`
- **Dashboard:** `orch server start|stop|status`
- **Logs:** `orch logs [--follow]`

Full command reference: see `orch --help`.

## Configuration

| Item | Default |
|------|---------|
| Config directory | `~/.config/orchestrator` |
| `ORCH_CONFIG_DIR` | Override config directory |
| `ORCH_UPDATE_INTERVAL` | Update check interval (default: `4h`) |

The daemon auto-starts on first command invocation (ssh-agent pattern). Background updater applies updates silently every `ORCH_UPDATE_INTERVAL`.
