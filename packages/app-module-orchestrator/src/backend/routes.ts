import type { RouteKey } from './adapter.js';

/**
 * The orch-core routes this module publishes, under app-core's /api/modules/orchestrator prefix.
 *
 * What the dashboard pages and dsl-lib-orch components call, and nothing more. Left out on purpose:
 * secrets and exec (no page uses them), import/export (not wired in any page), heartbeat and
 * events (they serve the dashboard server's own idle exit and an unused stream).
 *
 * /api/open is published because the log viewer's file links need it. It starts a program on the machine,
 * so it was only exposed once it stopped being able to run anything (documents and folders only, no shell,
 * not from another site): see orch-core's routes/open.ts.
 */
export const ALLOWED_ROUTES: readonly RouteKey[] = [
  'GET /api/jobs',
  'GET /api/jobs/:id',
  'POST /api/jobs',
  'PUT /api/jobs/:id',
  'DELETE /api/jobs/:id',
  'POST /api/jobs/:id/trigger',
  'POST /api/jobs/:id/trigger-early',
  'POST /api/jobs/:id/kill',
  'POST /api/jobs/:id/restart',
  'POST /api/jobs/:id/enable',
  'POST /api/jobs/:id/disable',
  'POST /api/jobs/:id/dry-run',
  'GET /api/jobs/:jobId/progress',
  'GET /api/jobs/:jobId/resource-baseline',
  'GET /api/jobs/:jobId/telemetry',
  'GET /api/jobs/:jobId/resource-history',
  'GET /api/failures',
  'POST /api/failures/ack',
  'GET /api/schedule',
  'GET /api/audit',
  'GET /api/uptime',
  'GET /api/health',
  'GET /api/daemon',
  'GET /api/logs/:jobId/runs',
  'GET /api/logs/:jobId/stream',
  'GET /api/open',
];

/**
 * The routes only the user in the browser may trigger: app-core answers 401 elevation-required (403 pin-not-set without a
 * PIN) to a request with no valid access token, and the shell asks for the PIN and repeats it.
 *
 * Chosen with the user (2026-11-21, "level 1 only"): the routes that write a command that then runs on its own schedule
 * (create, edit) and the one that deletes a job's history for good. Left out on purpose: trigger, trigger-early, restart and
 * dry-run (they run a command that is already stored), kill, enable, disable, failures/ack, and GET /api/open (a PIN at each
 * link click in a log, and it only opens documents and folders).
 */
export const SENSITIVE_ROUTES: readonly RouteKey[] = [
  'POST /api/jobs',
  'PUT /api/jobs/:id',
  'DELETE /api/jobs/:id',
];
