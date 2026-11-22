# Node watchdog (experimental)

A pure-Node parent of the daemon with the contract of the Go launcher. Phase A: opt-in only. The Go launcher stays the default, and start at login (Run key, LaunchAgent, systemd unit) still names it.

## Start

| Way | Effect |
|---|---|
| `orch start --watchdog` | Starts `node dist/orchestrator-watchdog.cjs <configDir>` instead of the launcher |
| `ORCH_WATCHDOG=1` | Same, for every start of the CLI (including the auto-start). `0` or unset: Go launcher. Any other value is an error |

Stop the running daemon first (`orch stop`): two parents of one config dir fight over the daemon.

The start is detached, hidden, stdio ignored, like the launcher's. The watchdog runs on the node that ran `orch` (`process.execPath`, no PATH lookup) and finds the daemon at `dist/orchestrator.cjs` next to itself, again at every (re)start. `LAUNCHER_BUNDLE_OVERRIDE` is honoured when set (a non-file is an error); `orch start --watchdog` strips an inherited one.

A watchdog started before `nvm use` or a node switch keeps its node and its package until `orch stop` + `orch start`.

## Contract

| Event | Watchdog |
|---|---|
| Daemon exits 0, no `config.restart` | Exits 0 |
| Daemon exits 0, `config.restart` present | Deletes it, starts the daemon again at once (not a crash). A sentinel it cannot delete: warning, no restart |
| Daemon exits non-zero, no stop signal received | Crash: writes `crashed.json`, waits 2 s, 10 s, 30 s, restarts. Max 3 restarts in any 10 minutes (crashes older than the window are forgotten); the 4th crash logs ERROR (log dir, `orch start`) and the watchdog exits with the daemon's last code |
| Daemon killed by a signal nobody sent | Crash (code -1 in the log; the watchdog itself exits 1 when it gives up) |
| Stop signal (POSIX SIGINT, SIGTERM) | Forwarded to the daemon; its exit is a stop, never restarted; the watchdog exits with its code. During a back-off: no restart, exits with the last crash code |
| Stop signal (Windows) | Nothing to forward. Logged, no crash; the daemon keeps running; stop it with `orch stop` (HTTP quit). Once a signal was received nothing is restarted |
| Node, bundle or spawn failure | ERROR with what to do, exit 1, no restart |

`config.update` of the Go launcher is not ported: nothing writes it.

`crashed.json` (`"source": "launcher"`, same fields as the Go launcher's): created exclusively. A file written by the daemon is never replaced; an older watchdog/launcher one (dated before the crashed run) is replaced; invalid JSON is left with a warning to delete it.

## Files

| File | Content |
|---|---|
| `<configDir>/logs/YYYY-MM-DD-launcher.log` | `[HH:MM:SS] [ INFO] [launcher] message`, same file and format as the launcher. Fallback: `<tmp>/orchestrator-launcher-fallback.log` with the reason. Also on stderr |
| `<configDir>/config.launcher-pid` | Watchdog pid, decimal, written at each start. Removed at exit if it is still ours (the Go launcher never removes it) |

Daemon environment: inherited, plus `ORCH_CONFIG_DIR=<configDir>`. Daemon stdout/stderr: the watchdog's own when it has them, the null device otherwise (as the launcher).

## Windows: watchdog gone

The Go launcher's Job Object killed the daemon with it. Here:

- libuv puts a child that is not detached in a kill-on-close job: a killed watchdog takes its daemon down at once (observed on Windows 10, covered by `test/watchdog-e2e.test.js`). A forced stop, not a graceful one.
- The watchdog also sets `ORCH_WATCHDOG_PID` in the daemon's environment. The daemon polls that pid every 5 s (unref'd timer, `src/watchdog/pid-watch.ts`); when it is gone it stops through the same path as SIGTERM (supervised jobs keep running, as on any stop) and exits 0. No sentinel, so nothing restarts it. It forces the exit 10 s later if the process is still alive. Absent variable (Go launcher, manual run): nothing happens. POSIX: the variable is never set.

## Test-only variables

| Variable | Effect |
|---|---|
| `ORCH_WATCHDOG_DELAYS_MS` | Comma list of positive integers replacing 2s,10s,30s (last one reused) |
| `ORCH_WATCHDOG_WINDOW_MS` | Positive integer replacing the 10 minutes |

A malformed value is an ERROR in the log and exit 1. Never set them outside tests.

## Code

`src/watchdog/`: `policy.ts` (window, back-off, env parsing), `watchdog.ts` (loop, sentinel, marker; every effect injected), `runtime.ts` (log, spawn, signals, files), `main.ts` (entry), `launch.ts` (`orch start --watchdog`), `pid-watch.ts` (daemon side). Bundled to `dist/orchestrator-watchdog.cjs` by `scripts/bundle.ts`.
