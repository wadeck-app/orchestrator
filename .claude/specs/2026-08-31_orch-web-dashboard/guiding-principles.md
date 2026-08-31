# Guiding Principles -- Orch Web Dashboard

These principles take priority in every design decision.
Any option that conflicts with a principle must be raised as an open question -- never silently accepted.

## Principles

### P-1: Daemon Stability
The daemon must survive any web server crash, restart, or idle shutdown without interruption.
**Why:** The daemon is the always-on process that runs jobs; the web server is optional and ephemeral. Coupling their lifecycles would risk job execution on every browser session.

### P-2: Local-Only
The dashboard binds exclusively to 127.0.0.1. No feature may require or enable network exposure.
**Why:** The dashboard has write access to the job registry and can trigger job execution. Exposing it on 0.0.0.0 would make it reachable from the local network without any authentication hardening designed for that threat model.

### P-3: On-Demand Resource Use
The web server runs only while the user is actively using it. Idle shutdown is not optional and must account for both HTTP activity and browser visibility.
**Why:** The orchestrator is a background tool. Keeping a Fastify server running 24/7 for occasional dashboard use wastes resources and increases the attack surface window unnecessarily.

### P-4: Feature Parity via UI
The v1 dashboard covers every action a user would normally do in a terminal for day-to-day orchestrator use. Power-user or advanced fields are deferred to v2 but must not be removed from the underlying data model.
**Why:** The dashboard replaces "open the config file" as the primary interaction mode. A dashboard that forces users back to the terminal for common actions fails its purpose.

### P-5: Reuse Over Reinvention
Existing packages and patterns are used as-is: @wadeck-app/dsl-renderer, @wadeck-app/dsl-ui, Fastify with @fastify/static (from agent-fleet), singleton-daemon-kit port-file conventions, and the tray-go child-process lifecycle pattern.
**Why:** Consistency across the workspace reduces cognitive overhead and maintenance surface. Custom alternatives to existing solutions must be justified by a concrete gap, not preference.
