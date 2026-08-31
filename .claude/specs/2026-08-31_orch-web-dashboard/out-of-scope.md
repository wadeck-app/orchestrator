# Out of Scope -- Orch Web Dashboard

Items listed here are **explicitly excluded**.
Raising an excluded item as a requirement is a change-of-scope conversation, not a design question.

## Excluded items

### Duration trending / sparklines
**Reason:** v2 -- adds charting complexity not justified for v1.
**Covered by:** v2 roadmap.

### Schedule timeline / Gantt view
**Reason:** v2 -- requires a calendar component; not a v1 priority.
**Covered by:** v2 roadmap.

### Overlap / conflict detection between jobs
**Reason:** v2 -- requires schedule analysis logic.
**Covered by:** v2 roadmap.

### Import / export job definitions
**Reason:** v2 -- out of scope for the initial UI.
**Covered by:** v2 roadmap.

### Dry-run command preview
**Reason:** v2 -- requires sandboxed execution context.
**Covered by:** v2 roadmap.

### Advanced job form fields: liveness, onExitCode, missedFiring
**Reason:** v2 -- power-user fields; users with these needs can still edit registry.json directly.
**Covered by:** v2 roadmap.

### Multi-user / authentication
**Reason:** Dashboard is local-only (127.0.0.1 binding); single local machine owner assumed.
**Covered by:** No authentication added in v1 -- accepted risk per Decision #13. The dashboard binds to 127.0.0.1 only.

### Remote / network access to the dashboard
**Reason:** Dashboard binds only to 127.0.0.1; remote access is explicitly out of scope.
**Covered by:** Threat model T-02.

## How to challenge scope
If you believe an item should be in scope, open a new discussion with the rationale.
Do not modify this file silently -- scope changes must be acknowledged as a versioned decision.
