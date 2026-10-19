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

/** A firing that was due and never spawned anything; see Scheduler._announceSkip. */
interface JobSkippedEvent {
  id: string;
  job: { label: string };
  reason: string;
  running?: number;
  maxConcurrency?: number;
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

  // The refusals that never reach job-finished (run still going from before a restart, liveness check) used to be
  // published for the queue only, so the audit trail did not know the job had been due. No exitCode and no
  // duration: nothing ran. A concurrency refusal stays out, as docs/daemon-config.md says: it repeats at every
  // firing while a long run holds the slot.
  scheduler.on('job-skipped', (ev: JobSkippedEvent) => {
    if (ev.reason === 'concurrency') {
      return;
    }
    try {
      audit.log('job.skipped', {
        jobId: ev.id, label: ev.job.label, reason: ev.reason,
        ...(ev.running !== undefined ? { running: ev.running } : {}),
        ...(ev.maxConcurrency !== undefined ? { maxConcurrency: ev.maxConcurrency } : {}),
      });
    } catch (err) {
      console.error('[audit:job-skipped]', err);
    }
  });
}
