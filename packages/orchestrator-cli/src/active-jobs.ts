import type { RuntimeEntry } from './types.js';

/**
 * How many jobs have a run still in flight, for GET /health and the updater's deferral decision.
 *
 * Liveness is finishedAt, not exitCode. A run cancelled by the user is recorded with exitCode null
 * on purpose, so that it reads as "Cancelled" rather than as a failure, and it keeps its finishedAt.
 * Counting null exitCodes therefore counted every cancelled run as still running for the rest of the
 * install's life: one daemon reported 3 active jobs with nothing executing, the updater deferred on
 * every attempt, and no update could be applied through the tray, the CLI or the interval. The
 * deferral message was true to its input and false about reality.
 *
 * Jobs, not runs: a job with two open runs is one job to wait for.
 *
 * Lives in its own module so the rule is exercised directly by tests. Inline in the health closure
 * it could only be checked by a test that restated it, which would have passed with the bug present.
 */
export function countActiveJobs(state: Record<string, RuntimeEntry[]>): number {
  return Object.values(state).filter(entries => entries.some(e => e.finishedAt == null)).length;
}
