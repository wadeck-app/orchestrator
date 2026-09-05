import React from 'react';
import type { Job } from '../types.js';

export interface NextFireCountdownProps {
  job: Job;
}

/**
 * @registryCategory atomic
 * @registryTags countdown schedule
 */
export function NextFireCountdown({ job }: NextFireCountdownProps): React.ReactElement {
  if (job.type === 'startup') {
    return <span className="text-sm text-muted">On startup</span>;
  }
  if (job.type === 'once') {
    return <span className="text-sm text-muted">Once</span>;
  }
  // cron: display raw schedule - next-fire calculation deferred to v2
  return <span className="text-sm text-muted">Cron: {job.schedule ?? '-'}</span>;
}
