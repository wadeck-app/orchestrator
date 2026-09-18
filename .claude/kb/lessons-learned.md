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
