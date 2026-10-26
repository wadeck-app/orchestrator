# Open points: state after 2026-10-26

## Done (commits on origin/main of the orchestrator unless noted)

| Item | Where |
|---|---|
| Daemon restarts after a crash (kit `CrashRestart`), checked live: kill, restart in 2 s, marker read and cleared | `df09f7d`; test `launcher-e2e.test.js` runs the same on Windows, macOS and Linux CI legs |
| `orch cli update` through the new launcher: no crash restart | checked live, `-533`, `-535` |
| Liveness `command` timeout (30 s default, `--liveness-timeout`, form field, display, parity test) | `f4b8301`, `1f0f1c6`, `1fb4097` |
| Daemon stdout/stderr lost under the launcher (NUL) -> bridged into the daemon log | `fb0fadd` (replaces the one-call `warn` workaround) |
| Linux x64/arm64 packages: launcher + supervisor, no tray; `PLATFORM_TARGETS` single table with a drift test | `787cbca`, kit `3bbfe66` |
| Start at login on Linux (systemd user unit, `KillMode=process`) | `d1b9716` (tests only, no systemd host) |
| `orch status` lists pending restarts; restart counters persisted | `ffaf631` |
| Dashboard: restart policy, log rotation, liveness on the job page; segments in the log picker | `1fb4097`, seen in the real page |
| Status widget showed two red messages for a down daemon | `d7158f8` |
| Kit: `go test` on 3 OS before publish; stop signal that cannot be forwarded is warned; gofmt; version format in `package.json` | kit `aad0e94`..`8909a9d`, published `2026.10.26-100-8909a9d1` |
| Cleanup of scratch files, vite dev server 63652, `.violations/.gitignore` of orch-app versioned | `dc1037e` |

## Still open

1. **Real Linux host**: nothing has run on one. CI covers launcher/daemon e2e and the supervisor on ubuntu, not systemd, not arm64.
2. **Job list and job detail pages show two red messages** with the daemon down (renderer banner + `DaemonStatus`/`ResourceHistory`). Cause: `notifyLoadFailure` in `@wadeck-app/dsl-renderer` has no per-source silence; `orch-app` cannot pass `hostNotify` without rewriting the banner. Needs a renderer option (other repo). Pinned by `orch-app/src/page-daemon-down.test.tsx`.
3. **Windows console close**: the launcher cannot forward an interrupt (Go: `Process.Signal` is `os.Kill` only there); it now warns. Options: `Kill` (loses graceful shutdown) or a launcher `Config` field for an HTTP quit. Needs a decision.
4. **Progress/ETA strategies learn from the head of a rotated run only**: the dropped segments are gone, so this is inherent, documented in `docs/daemon-config.md`. No change planned unless a learned strategy must work on runs above 250 MB.
5. **Kit docs say version `1.YYYYMMDDHHMMSS.BUILD`** (real: `YYYY.MM.DD-BUILD-sha`): `CLAUDE.md`, `README.md` (both with uncommitted changes of someone else) and `.claude/guiding-principles.md` (untracked). Kit `CLAUDE.md` also says `go test ./go-launcher/...` from the root, which cannot work.
6. Kit smaller: PE metadata is skipped with a plain echo when `goversioninfo` is absent (the published launcher can lack it); `realsignal_windows_test.go` leaves a `ping` child for ~30 s.
7. `disableStartup` (macOS, Linux) does not check the entry belongs to this config dir.
8. `packages/orchestrator-cli/app-module/dsl-frontend/status-widget.json` is a stale compiled copy.
9. `retryOnExitCodes`, `retryDelays`, `skipExitCodes` are not shown on the job page.

## Rules kept

- Agents implement in TDD; the result is verified by my own runs and screenshots before it is reported.
- No flaky tests: FakeTime, events instead of sleeps, retries on Windows `rmSync`.
- Commits by explicit paths, one subject each; `queue wait ci` after every push; peers cannot approve for the user.
