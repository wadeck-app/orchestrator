import type { EventEmitter } from 'node:events';

/** Just enough of the audit logger to record an event; keeps this module testable without a daemon. */
interface AuditSink {
  log(event: string, payload: Record<string, unknown>): void;
}

interface JobFinishedEvent {
  id: string;
  exitCode: number;
  job: { label: string };
  skipped?: boolean;
  durationMs?: number;
  trigger?: { kind: string };
}

/**
 * Registers the scheduler listeners that feed the audit trail.
 *
 * Extracted from the daemon bootstrap so the event-to-audit mapping can be tested: index.ts has no
 * harness, which is how a skipped run came to be logged as `job.completed` -- an event the dashboard's
 * audit view renders with a failure icon, reintroducing the false alarm the skip logic removes.
 */
export function wireAuditEvents(scheduler: EventEmitter, audit: AuditSink): void {
  scheduler.on('job-finished', (ev: JobFinishedEvent) => {
    try {
      // Optional fields are added only when known, so an entry never carries an `undefined` key.
      audit.log(ev.skipped ? 'job.skipped' : 'job.completed', {
        jobId: ev.id, label: ev.job.label, exitCode: ev.exitCode,
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        ...(ev.trigger ? { trigger: ev.trigger.kind } : {}),
        // The only run the scheduler reports as skipped through job-finished is one whose exit code the
        // job declared in skipExitCodes; a liveness skip never spawns, so never reaches here.
        ...(ev.skipped ? { reason: 'skipExitCodes' } : {}),
      });
    } catch (err) {
      // The audit trail is a side channel. A failure to write it must not propagate into the
      // scheduler's own emit, where it would surface as an unhandled error on a job that ran fine.
      console.error('[audit:job-finished]', err);
    }
  });
}
