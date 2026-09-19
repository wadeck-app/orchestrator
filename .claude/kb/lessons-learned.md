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

**Problem:** A hand-rolled `npm install -g` leaves the CLI and the daemon on different versions when it half-applies, and skips the deferral that holds an update back while a job is running.
**Fix:** Run `orch cli update`.
**Context:** It restarts the daemon onto the new version for you (`config.restart` sentinel + `POST /quit`, `src/updater/entry.ts:151`) and defers while jobs are running unless `UPDATER_FORCE=1`. It does **not** protect against the Windows EBUSY below: `execNpm` runs the same `npm install -g <pkg>@<version>` with no extra flags, and the install happens *before* anything is stopped. An earlier version of this entry claimed the updater frees the file lock first -- it does not, and that claim was an inference made without reading the order of operations.

---

### Windows: `orch cli update` fails with EBUSY because the launcher-based update path is no longer used

**Problem:** Updating on Windows dies with `EBUSY ... orchestrator-cli-win32-x64/orchestrator.exe`, because `shared-updater`'s `without-daemon` strategy runs `npm install -g` in-process (`dist/strategies/without-daemon.js:71`) while `orchestrator.exe` (the resident Go launcher) and the `orchestrator-tray.exe` processes still hold files in the very directory npm has to replace; the `POST /quit` that would free them only happens afterwards (`:110`) and deliberately keeps the launcher alive.
**Fix:** Fixed in 45156bd by never executing a native binary from node_modules: the launcher and the tray are copied to `<configDir>/bin/<platform-package-version>/` and run from there, so nothing holds a file npm has to move. Publication, the exact-version pin and `require.resolve` are unchanged -- only the run location moved. `refreshStartupEntry` rewrites the login entry to the staged path on its own at daemon start.
**Context:** The Windows-safe path already exists and is configured but is never triggered. `launcher.go:245-262` → `:385` calls `spawnUpdateAndExit`, whose own comment is "Exiting releases the file lock on the running .exe so npm can overwrite it", and `ci/launcher.config.json` sets `updateCmd`. Nothing in `packages/orchestrator-cli/src` writes `config.update` (zero occurrences) -- only `config.restart`. It is a regression: `update-log.txt` still holds `Sentinel written — launcher will install ...` from 2026-08-30 and that string exists nowhere in the source today. Invisible on macOS/Linux, which have no mandatory file locking. Note the generated VBS runs `oShell.Run cmd, 0, False` and restarts nothing, so the sentinel path leaves the daemon down after installing.

**Addendum (intermittency, unresolved):** The same `orch cli update` that failed with EBUSY at 16:27 succeeded at 22:40 on the same machine with the launcher and both tray processes running throughout. `execNpm` is a plain `npm install -g`, so the command is not the variable. The failing operation was npm copying the running `orchestrator.exe` into its staging directory (`.orchestrator-cli-wnb1ETbR`) before replacing the parent package, so it turns on whether npm decides it must re-stage that nested directory -- not something to guess at. Whichever of the two fixes is chosen removes the dependence entirely, by not holding the lock while npm runs.
