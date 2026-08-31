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

### User expects full autonomy -- act and parallelize without asking

**Problem:** Repeatedly asked for confirmation before executing clear next steps, causing frustration.
**Fix:** After a decision is made, execute immediately. Launch parallel agents for independent workstreams in a single message. Only pause when a decision is genuinely open.
**Context:** User explicitly corrected multiple times ("autonomie!!!!", "en parallel quand possible"). Asking "should I proceed?" wastes time when the path is already decided.
