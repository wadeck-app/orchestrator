# Lessons Learned

Add entries with `/kb`. See `~/.claude/skills/kb/SKILL.md` for format.

---

### Lessons learned always go in the project, never in ~/.claude/kb

**Problem:** Attempted to write a lesson learned to the global `~/.claude/kb/lessons-learned.md` instead of the project-local `.claude/kb/lessons-learned.md`.
**Fix:** Always write to `<project>/.claude/kb/lessons-learned.md`. Never write to `~/.claude/kb/`.
**Context:** The global kb is not the target regardless of whether the lesson seems "general" -- the project kb is always the right location.

---

### Spec mode: never self-approve a spec

**Problem:** Marking a spec status as "Approved" without explicit user confirmation violates the spec protocol and removes the user's approval gate.
**Fix:** Keep status at "In Review" after all questions are resolved and wait for the user to explicitly approve before changing status to "Approved".
**Context:** The user is the sole authority on spec approval. "All questions resolved" means the spec is ready for review, not that it is approved.

---

### Always build and test locally before pushing to CI

**Problem:** Pushed code with TypeScript errors (missing DOM lib, wrong module setting, broken ESM spy) that only manifested in CI, causing many fix-push-poll cycles.
**Fix:** Run `npm run build --workspaces --if-present` and `npm test --workspaces --if-present` locally before any push.
**Context:** CI environment matches local exactly for TypeScript/Vitest errors. No excuse to skip this step.

---

### User expects full autonomy -- act and parallelize without asking

**Problem:** Repeatedly asked for confirmation before executing clear next steps, causing frustration.
**Fix:** After a decision is made, execute immediately. Launch parallel agents for independent workstreams in a single message. Only pause when a decision is genuinely open.
**Context:** User explicitly corrected multiple times ("autonomie!!!!", "en parallel quand possible"). Asking "should I proceed?" wastes time when the path is already decided.

---

### Update orch with `orch cli update`, never `npm install -g` by hand

**Problem:** `npm install -g @wadeck-app/orchestrator-cli@<v>` fails with `EBUSY ... orchestrator-cli-win32-x64/orchestrator.exe` while the daemon runs, and a half-applied install leaves the CLI and the daemon on different versions.
**Fix:** Run `orch cli update`.
**Context:** The updater exists for exactly this: strategy `without-daemon` + `restartDaemon` (`src/updater/entry.ts:151`) writes a `config.restart` sentinel then `POST /quit`, so the Go launcher relaunches the daemon on the new version and nothing holds the native binary during the install. It also defers while jobs are running, unless `UPDATER_FORCE=1`. Stopping the daemon by hand first does work, but it skips the deferral and is not the supported path -- do not teach it as the rule.

---

### Windows: `orch cli update` fails with EBUSY because the launcher-based update path is no longer used

**Problem:** Updating on Windows dies with `EBUSY ... orchestrator-cli-win32-x64/orchestrator.exe`, because `shared-updater`'s `without-daemon` strategy runs `npm install -g` in-process (`dist/strategies/without-daemon.js:71`) while `orchestrator.exe` (the resident Go launcher) and the `orchestrator-tray.exe` processes still hold files in the very directory npm has to replace; the `POST /quit` that would free them only happens afterwards (`:110`) and deliberately keeps the launcher alive.
**Fix:** Not fixed yet -- deliberately left alone. Two options: stop tray+launcher+daemon inside `onUpdateAvailable` (which runs before the install) and relaunch afterwards, all inside this repo; or restore the `config.update` sentinel, which needs `singleton-daemon-kit` to relaunch orch after the hidden install.
**Context:** The Windows-safe path already exists and is configured but is never triggered. `launcher.go:245-262` → `:385` calls `spawnUpdateAndExit`, whose own comment is "Exiting releases the file lock on the running .exe so npm can overwrite it", and `ci/launcher.config.json` sets `updateCmd`. Nothing in `packages/orchestrator-cli/src` writes `config.update` (zero occurrences) -- only `config.restart`. It is a regression: `update-log.txt` still holds `Sentinel written — launcher will install ...` from 2026-08-30 and that string exists nowhere in the source today. Invisible on macOS/Linux, which have no mandatory file locking. Note the generated VBS runs `oShell.Run cmd, 0, False` and restarts nothing, so the sentinel path leaves the daemon down after installing.
