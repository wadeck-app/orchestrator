import type { Job, ProgressEstimate, RuntimeEntry } from './types.js';

// A job paired with its run history, as returned by GET /api/jobs.
export interface JobWithHistory {
  job: Job;
  runHistory: RuntimeEntry[];
  /** Progress and ETA of a running job; null when the job has no open run. Absent from a daemon that predates it. */
  progress?: ProgressEstimate | null;
}
