import type { Job, RuntimeEntry } from './types.js';

// A job paired with its run history, as returned by GET /api/jobs.
export interface JobWithHistory {
  job: Job;
  runHistory: RuntimeEntry[];
}
