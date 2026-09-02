import React from 'react';
import type { Job } from '../types.js';

export interface JobConfigDisplayProps { job: Job; }

// @formatter:off
const LABEL_CLS = 'text-xs font-medium text-muted uppercase tracking-wide';
const VALUE_CLS  = 'mt-1 font-mono text-sm text-content break-all';
// @formatter:on

/**
 * @registryCategory composite
 * @registryTags job config display
 */
export function JobConfigDisplay({ job }: JobConfigDisplayProps): React.ReactElement | null {
  if (!job) return null;
  return (
    <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
      <div><span className={LABEL_CLS}>Command</span><p className={VALUE_CLS}>{job.command}</p></div>
      {job.cwd && <div><span className={LABEL_CLS}>Working directory</span><p className={VALUE_CLS}>{job.cwd}</p></div>}
      {job.type === 'cron' && job.schedule && <div><span className={LABEL_CLS}>Schedule</span><p className={VALUE_CLS}>{job.schedule}</p></div>}
      {job.type === 'startup' && job.delaySeconds !== undefined && <div><span className={LABEL_CLS}>Startup delay</span><p className="mt-1 text-sm text-content">{job.delaySeconds}s</p></div>}
      <div><span className={LABEL_CLS}>Trigger mode</span><p className="mt-1 text-sm text-content">{job.triggerMode}</p></div>
      {job.missedFiring && <div><span className={LABEL_CLS}>Missed firing</span><p className="mt-1 text-sm text-content">{job.missedFiring}</p></div>}
    </div>
  );
}
