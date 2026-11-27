# Node watchdog

The only parent of the daemon. It replaced the Go launcher (removed in phase C of the migration), whose contract it keeps. `orch start` and start at login both run it.

Remove one release after phase C: the detection of a start-at-login entry that still names the Go launcher (`inspectStartupEntry` in `src/startup.ts`, state `outdated`), and the `--launcher` / `ORCH_LAUNCHER` error in `src/watchdog/launch.ts`.

## Start

| Way | Effect |
|---|---|
| `orch start` | Starts `node dist/orchestrator-watchdog.cjs <configDir>` |
| `orch start --launcher`, any non-empty `ORCH_LAUNCHER` | Error: the Go launcher was removed. Install an older version to get it back (`npm install -g @wadeck-app/orchestrator-cli@<version>`) |
| `--watchdog`, `ORCH_WATCHDOG` | Deprecated (the first release's opt-in): ignored with a one-line note on stderr |

Stop the running daemon first (`orch stop`): two parents of one config dir fight over the daemon.

The start is detached, hidden, stdio ignored. The watchdog runs on the node that ran `orch` (`process.execPath`, no PATH lookup) and finds the daemon at `dist/orchestrator.cjs` next to itself, again at every (re)start. `LAUNCHER_BUNDLE_OVERRIDE` is honoured when set (a non-file is an error); `orch start` strips an inherited one. A package without `dist/orchestrator-watchdog.cjs` (a checkout that was not bundled): `orch start` fails and says to run `npm run bundle`.

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

The Go launcher's `config.update` sentinel is not ported: nothing writes it.

`crashed.json` (`"source": "launcher"`, the field kept from the Go launcher): created exclusively. A file written by the daemon is never replaced; an older watchdog/launcher one (dated before the crashed run) is replaced; invalid JSON is left with a warning to delete it.

## Files

| File | Content |
|---|---|
| `<configDir>/logs/YYYY-MM-DD-launcher.log` | `[HH:MM:SS] [ INFO] [launcher] message`, name and format kept from the Go launcher. Fallback: `<tmp>/orchestrator-launcher-fallback.log` with the reason. Also on stderr |
| `<configDir>/config.launcher-pid` | Watchdog pid, decimal, written at each start. Removed at exit if it is still ours |

Daemon environment: inherited, plus `ORCH_CONFIG_DIR=<configDir>`. Daemon stdout/stderr: the watchdog's own when it has them, the null device otherwise.

## Windows: watchdog gone

- libuv puts a child that is not detached in a kill-on-close job: a killed watchdog takes its daemon down at once (observed on Windows 10, covered by `test/watchdog-e2e.test.js`). A forced stop, not a graceful one.
- The watchdog also sets `ORCH_WATCHDOG_PID` in the daemon's environment. The daemon polls that pid every 5 s (unref'd timer, `src/watchdog/pid-watch.ts`); when it is gone it stops through the same path as SIGTERM (supervised jobs keep running, as on any stop) and exits 0. No sentinel, so nothing restarts it. It forces the exit 10 s later if the process is still alive. Absent variable (a daemon under an old Go launcher, manual run): nothing happens. POSIX: the variable is never set.

## Test-only variables

| Variable | Effect |
|---|---|
| `ORCH_WATCHDOG_DELAYS_MS` | Comma list of positive integers replacing 2s,10s,30s (last one reused) |
| `ORCH_WATCHDOG_WINDOW_MS` | Positive integer replacing the 10 minutes |

A malformed value is an ERROR in the log and exit 1. Never set them outside tests.

## Code

`src/watchdog/`: `policy.ts` (window, back-off, env parsing), `watchdog.ts` (loop, sentinel, marker; every effect injected), `runtime.ts` (log, spawn, signals, files), `main.ts` (entry), `launch.ts` (`orch start` mode, spawn spec), `pid-watch.ts` (daemon side). Bundled to `dist/orchestrator-watchdog.cjs` by `scripts/bundle.ts`. Start at login: `src/start-bootstrap.ts` (bootstrap text, VBS, Run value), `src/startup.ts` (entries, inspection), `src/startup-check.ts`.

## Start at login

Registered by `orch install`, rewritten at every daemon start. It names node and a tiny stable bootstrap in the config dir, never the watchdog's own path (an `nvm use`, a node upgrade or a moved npm prefix would leave a path that is gone).

| File in `<configDir>` | Content |
|---|---|
| `orchestrator-start.cjs` | Static plain CJS, versioned by its first line, rewritten when its text differs |
| `orchestrator-start.vbs` | Windows only. UTF-16 with BOM (a non-ASCII path survives). Starts the bootstrap with window style 0, no shell, no wait; a failed start is logged, not shown as a dialog |

| OS | Entry |
|---|---|
| Windows | Run value `wscript.exe //nologo "<configDir>\orchestrator-start.vbs"` (paste it into cmd.exe to emulate a login) |
| macOS | LaunchAgent `ProgramArguments` = node, bootstrap, configDir, hint; `RunAtLoad`, no `KeepAlive`, `PATH` as before |
| Linux | `ExecStart` = the same four words, `Restart=no`, `KillMode=process`; linger logic unchanged |

The fourth word (hint) is the watchdog of the install that wrote the entry. Node is the `process.execPath` of that writer, baked in.

The bootstrap runs the watchdog IN-PROCESS (`require`, argv reduced to the config dir): one resident node, and `config.launcher-pid` is its pid. A detached child would be a second process and a wrong pid. Search order, first file found wins (`<pkg>` = `@wadeck-app/orchestrator-cli/dist`):

1. `LAUNCHER_BUNDLE_OVERRIDE`: the watchdog next to that daemon bundle; if absent, an error (never second-guessed)
2. `<node folder>/node_modules/<pkg>` (Windows installer, nvm-windows)
3. Not Windows: `<node folder>/../lib/node_modules/<pkg>`
4. `npm_config_prefix` / `NPM_CONFIG_PREFIX`
5. Windows: `%APPDATA%\npm\node_modules\<pkg>` (the global prefix outside node's folder)
6. The hint (last: it names the install seen at write time and can be stale after `nvm use`)

Nothing found, a package with no watchdog (an older version), or a watchdog that does not load: one `ERROR` line in `<configDir>/logs/YYYY-MM-DD-launcher.log` (same file and format as the watchdog) saying what to run, exit 1.

### Migration

| Situation | Check (`inspectStartupEntry`) | Result |
|---|---|---|
| Entry names the removed Go launcher, install has the watchdog | `outdated` | Rewritten to the bootstrap by the next `orch` command or daemon start. Nothing about the launcher is checked (its file, its `node_modules` link). The staged copy under `<configDir>/bin/<stamp>/` is pruned once the rewrite succeeded |
| Entry names the Go launcher, install has no watchdog | `broken` | Cannot be rewritten: the message says to run `npm install -g @wadeck-app/orchestrator-cli`, then `orch install` |
| Entry names the bootstrap, install has no watchdog (`npm install -g @older`) | `broken` | Same message. `orch install` and a daemon refresh refuse with it: there is no fallback |
| Bootstrap, script or node missing, or the files differ from this version | `broken` | Rewritten |
| Entry started under another node than the caller's | `drift` | Reported by `orch status`, never rewritten |

Remaining gap: after `npm install -g @older` and a reboot before any `orch` command, the login runs the bootstrap, which logs "has no orchestrator-watchdog.cjs (an older version)" and exits 1; `orch start` repairs it. `orch uninstall` removes the entry, the bootstrap and the script.

An install that updates from the Go launcher era: the old launcher keeps running the daemon (it restarts the new bundle after `orch cli update`) until the next stop or reboot; the new daemon rewrites the entry at its first start.
