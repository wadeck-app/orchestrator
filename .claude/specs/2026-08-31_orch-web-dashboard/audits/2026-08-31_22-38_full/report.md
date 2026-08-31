# Audit Report -- Full (Security + Completeness + Consistency + Architecture) -- Orch Web Dashboard

**Date:** 2026-08-31
**Spec version:** v0.1
**Auditor:** Claude (spec mode)

## Scope

Files reviewed:
- `_index.md`
- `guiding-principles.md`
- `out-of-scope.md`
- `threat-model.md`
- `architecture.md`
- `frontend.md`

---

## Executive Summary

The spec has two CRITICAL contradictions between the auth decision (Decision #13: no auth, accepted risk) and the module files (architecture.md and frontend.md) which were written BEFORE Decision #13 was made and still describe a startup-token + session-cookie mechanism. These must be reconciled before implementation. Two HIGH structural gaps were also found: the Open Questions table was never updated (all 8 questions still show "Open"), and the `RunHistory` component assumes multi-entry history that the existing `State` class does not support.

---

## Findings

| ID | Severity | Finding | File / Section | Recommendation |
|---|---|---|---|---|
| A-01 | CRITICAL | architecture.md "Authentication" section fully describes startup token + session cookie (401 on missing cookie, HttpOnly cookie, token in URL) -- directly contradicts Decision #13 which accepted no-auth as the v1 approach | architecture.md / REST API Contract / Authentication | Remove or replace the Authentication section; replace with "No authentication in v1 -- see Decision #13. All /api/* routes are accessible to any local process." |
| A-02 | CRITICAL | architecture.md spawn command includes `--token <startupToken>` and the port-file section shows the token embedded in the browser URL -- both are artifacts of the rejected auth mechanism | architecture.md / Daemon Lifecycle / Spawn | Remove `--token` from the spawn command; remove token from the browser URL construction |
| A-03 | HIGH | The Open Questions table in _index.md was never updated -- all 8 questions (#2 through #8) still show status "Open" despite being resolved as Decisions #2-9 | _index.md / Open Questions | Mark questions #2-8 as Resolved, linking each to its corresponding Decision # |
| A-04 | HIGH | frontend.md Security Considerations section says "The startup token in the initial URL (?token=) is consumed on first load and not re-used" -- contradicts Decision #13 | frontend.md / Security Considerations | Remove all references to the startup token; replace with a note that no auth is used in v1 per Decision #13 |
| A-05 | HIGH | `RunHistory` component (frontend.md) shows "last 20 entries from GET /api/jobs/:id" -- but the existing `State` class stores only ONE RuntimeEntry per job (it overwrites on each run). There is no multi-entry history API or data store specified anywhere | frontend.md / Page: /jobs/:id | Either (a) descope RunHistory to show the single last entry, or (b) add a decision to extend `State` to store N entries per job. This is an unresolved implementation gap. |
| A-06 | HIGH | Decision #2 says "add packages/orch-ui and packages/orch-app" (only 2 new packages) -- but Decision #9 correctly adds 3 new packages (orch-server, orch-ui, orch-app). Decision #2 is incomplete | _index.md / Decision Log #2 | Update Decision #2 to mention orch-server or note it was superseded by Decision #9 |
| A-07 | MEDIUM | out-of-scope.md "Multi-user / authentication" says "Startup token provides sufficient protection" -- this contradicts Decision #13 (no startup token; accepted risk) | out-of-scope.md | Update the reason to match Decision #13: "No auth added in v1; accepted risk for single-user local tool per Decision #13" |
| A-08 | MEDIUM | `orch dashboard` CLI command is mentioned in architecture.md as a way to open the dashboard from the terminal, but it has no decision, no spec for its arguments, and no package assignment | architecture.md / Daemon Lifecycle / Spawn | Add a decision or explicitly defer this command to v2 |
| A-09 | MEDIUM | `once` job type: frontend.md says "no extra fields" for once-type jobs, but the Job type has `delayMs` and `scheduledAt` fields. It is not decided whether the add-job form should expose a delay for once-type jobs | frontend.md / JobForm fields | Decide: show `delayMs` input for once-type jobs in v1, or hide it (job fires immediately with no delay) |
| A-10 | MEDIUM | config.dashboard staleness: architecture.md specifies a 60s staleness check for `config.port` (daemon), but does not specify how the daemon decides orch-server is already running before skipping a spawn -- no staleness rule for `config.dashboard` | architecture.md / Daemon Lifecycle / Spawn | Add the same 60s staleness rule for `config.dashboard`; if stale, treat server as dead and re-spawn |
| A-11 | INFO | _index.md Summary section contains an HTML comment placeholder (`<!-- One paragraph... -->`) above the actual summary text | _index.md / Summary | Remove the comment |
| A-12 | INFO | architecture.md security table still lists "Startup token" and "Session cookie" rows -- residual from before Decision #13 | architecture.md / Security table | Remove the startup token and session cookie rows from the security table |

---

## New Open Questions Raised

1. **RunHistory data model** (from A-05): Should `State` be extended to store N entries per job, or should RunHistory be descoped to show only the single last entry in v1?
2. **`orch dashboard` CLI command** (from A-08): Should `orch dashboard` (open the web UI from the terminal) be a v1 feature? If so, which package handles it and what are its arguments?
3. **`once` job delay field in form** (from A-09): Does the add-job form expose `delayMs` for once-type jobs, or does the job fire immediately with no delay?
