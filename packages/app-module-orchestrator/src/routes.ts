import type { RouteKey } from './adapter.js';

/**
 * The orch-server routes this module publishes, under app-core's /api/modules/orchestrator prefix.
 *
 * What the dashboard pages and orch-ui components call, and nothing more. Left out on purpose:
 * secrets and exec (no page uses them), import/export (not wired in any page), heartbeat and
 * events (they serve the dashboard server's own idle exit and an unused stream), and /api/open
 * (it launches a shell command; it would need its own review before a module exposed it).
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
  'POST /api/jobs/:id/enable',
  'POST /api/jobs/:id/disable',
  'POST /api/jobs/:id/dry-run',
  'GET /api/jobs/:jobId/resource-baseline',
  'GET /api/failures',
  'POST /api/failures/ack',
  'GET /api/schedule',
  'GET /api/audit',
  'GET /api/uptime',
  'GET /api/health',
  'GET /api/logs/:jobId/runs',
  'GET /api/logs/:jobId/stream',
];
