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

1. **Real Linux host**: nothing has run on one. CI covers launcher/daemon e2e and the supervisor on ubuntu, not systemd, not arm64.
2. **A table reads as empty when its source failed.** With the daemon down the job page shows "No runs yet" for a job that has runs, which is why its generic banner is kept (a page that owns the explanation is only the job list). Fix: use `$ctx.$sourceErrors` (dsl-view `2026.10.26-295`) to show "cannot be read" instead of the empty text, then the job page can drop the generic banner.
3. **Windows console close**: the launcher cannot forward an interrupt (Go: `Process.Signal` is `os.Kill` only there); it now warns. Options: `Kill` (loses graceful shutdown) or a launcher `Config` field for an HTTP quit. Needs a decision.
4. **Progress/ETA strategies learn from the head of a rotated run only**: the dropped segments are gone, so this is inherent, documented in `docs/daemon-config.md`. No change planned unless a learned strategy must work on runs above 250 MB.
5. **Node DEP0190** is still possible from `exec-manager.ts` and the default `spawn` of `scheduler.ts` (`spawn(bin, args, {shell:true})`), i.e. `orch exec` and unsupervised runs; the tests print it a dozen times. The one at every daemon start was `pidusage` 4.0.1 (fixed by 4.1.0, `fc7e4c2`) and the tray's `npm view` (`5421b24`). Fix for the rest: pass the original command string (same shell semantics) and adapt the tests that assert `(bin, args)`.
6. **CI ubuntu flake, unexplained**: run `40405633462` (`980e4ef`) ended with exit 137: the test output stops after a normal test, 31 s of silence, then the `strace` wrapper is `Killed`. No assertion failed; Windows and macOS legs of the same run and the four previous ubuntu runs were green. Same family as runs 419 and 421 noted in the workflow. The next push (same code) was green, so it did not repeat; nothing was changed for it.
7. **Kit docs say version `1.YYYYMMDDHHMMSS.BUILD`** (real: `YYYY.MM.DD-BUILD-sha`): `CLAUDE.md`, `README.md` (both with uncommitted changes of someone else) and `.claude/guiding-principles.md` (untracked). Kit `CLAUDE.md` also says `go test ./go-launcher/...` from the root, which cannot work.
8. Kit smaller: PE metadata is skipped with a plain echo when `goversioninfo` is absent (the published launcher can lack it); `realsignal_windows_test.go` leaves a `ping` child for ~30 s.

## Rules kept

- Agents implement in TDD; the result is verified by my own runs and screenshots before it is reported.
- No flaky tests: FakeTime, events instead of sleeps, retries on Windows `rmSync`.
- Commits by explicit paths, one subject each; `queue wait ci` after every push; peers cannot approve for the user.
