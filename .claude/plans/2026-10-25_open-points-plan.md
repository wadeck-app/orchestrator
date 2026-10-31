# Open points: state after 2026-10-26

## Done (commits on origin/main of the orchestrator unless noted)

| Item | Where |
|---|---|
| Daemon restarts after a crash (kit `CrashRestart`), checked live: kill, restart in 2 s, marker read and cleared | `df09f7d`; `launcher-e2e.test.js` runs the same on Windows, macOS and Linux CI legs |
| `orch cli update` through the new launcher: no crash restart | checked live (`-533`, `-535`, `-551`) |
| Liveness `command` timeout (30 s default, `--liveness-timeout`, form field, display, parity test) | `f4b8301`, `1f0f1c6`, `1fb4097` |
| Daemon stdout/stderr lost under the launcher (NUL) -> bridged into the daemon log; seen live in the real daemon log | `fb0fadd` |
| What the bridge revealed, fixed: tray `npm view` used `execFile` + `shell:true` (Node DEP0190 at every start); tray stderr logged twice | `5421b24`, `0954942` |
| Linux x64/arm64 packages: launcher + supervisor, no tray; `PLATFORM_TARGETS` single table with a drift test | `787cbca`, kit `3bbfe66` |
| Start at login on Linux (systemd user unit, `KillMode=process`); `orch uninstall` refuses another config dir's entry (macOS and Linux) | `d1b9716`, `cc75484` (tests only, no systemd host) |
| `orch status` lists pending restarts; restart counters persisted | `ffaf631` |
| Dashboard: restart policy, retries, skipped codes, log rotation, liveness on the job page; segments in the log picker; liveness timeout field | `1fb4097`, `a877843`, seen in the real page |
| Down daemon: status widget one message (`d7158f8`); job list one message through the renderer's `shouldNotifyLoadFailure` (dsl-view `e3eadd2`) | `980e4ef`; seen in the real page |
| Kit: `go test` on 3 OS before publish; unforwardable stop signal warned; gofmt; version format in `package.json` | kit `aad0e94`..`8909a9d`, published `2026.10.26-100-8909a9d1` |
| Handled-run folder removal failure is said; its test no longer races a supervisor that is exiting | `ebf4ce7` |
| `pidusage` 4.1.0: no Node DEP0190 at the first resource sample; counters of a removed or switched-off job are forgotten; counters seen restored on the real daemon after `orch restart` | `fc7e4c2`, this commit |
| Cleanup of scratch files, vite dev server, `.violations/.gitignore` of orch-app versioned | `dc1037e` |

## Still open

1. **Real Linux host**: waits for the user's Linux server (to be installed later). Until then CI covers launcher/daemon e2e and the supervisor on ubuntu, not systemd, not arm64. WSL2 Ubuntu with systemd exists on this machine but has no Node; installing one was refused.
2. **Windows console close**: decided, no change. The shipped launcher is a GUI executable with no console, so the case only exists in a development build with a console; the real stop is the HTTP `quit`, and the launcher warns when it cannot forward an interrupt. Revisit if a console launcher ships.
3. **`orch exec` is never supervised**, by design (plain children of the daemon). `orch stop`, `restart` and `cli update` now warn about the running ones (`130c420`, from `exec-list`). Not done: `orch status` does not list them, so the "wait for them" way out has no command; the tray and dashboard quit confirmations were not checked.
4. **Progress/ETA strategies learn from the head of a rotated run only**: the dropped segments are gone, so this is inherent, documented in `docs/daemon-config.md`. No change planned unless a learned strategy must work on runs above 250 MB.
5. **CI ubuntu flake, unexplained**: run `40405633462` (`980e4ef`) ended with exit 137: the test output stops after a normal test, 31 s of silence, then the `strace` wrapper is `Killed`. No assertion failed; the next push (same code) was green. Same family as runs 419 and 421 noted in the workflow. The CI relay (`queue wait ci`) has delivered nothing from this repository for 24 h: runs are followed through the GitHub API.
6. **Kit docs**: `CLAUDE.md` is fixed (`6ab86e9`). `README.md` (uncommitted rewrite of someone else) and `.claude/guiding-principles.md` (untracked) still say version `1.YYYYMMDDHHMMSS.BUILD`.
7. **Kit `build.sh`**, noticed and not fixed: `$CONFIG_FILE` goes into `node -e "require('...')"` unescaped; the display name goes into a `sed` expression (a `/` or `&` corrupts the version info); `golang.org/x/sys` is pinned in the generated go.mod apart from the repo's; `REQUIRE_LINES` is computed and unused; PE metadata is skipped without a word when `versioninfo.json` is missing.
8. **Asked through app-core-owner, relayed from a remote agent** (`wapp-cron-jira`): the `##orch-progress` contract is now documented rule by rule (`docs/daemon-config.md`, "Reporting progress from a job", `7f35aaa`). The second ask, the last progress message in the human line of `orch status`, is NOT done: the message is in the reason (`orch status --json`, dashboard tooltip) but the human line shows only the percent and the end time. Waiting for the user's yes.

## Rules kept

- Agents implement in TDD; the result is verified by my own runs and screenshots before it is reported.
- No flaky tests: FakeTime, events instead of sleeps, retries on Windows `rmSync`.
- Commits by explicit paths, one subject each; `queue wait ci` after every push; peers cannot approve for the user.
