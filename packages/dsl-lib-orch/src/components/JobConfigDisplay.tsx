import React from 'react';
import type { Job } from '../types.js';
import { isLongRunning } from '../long-running.js';
import { describeResourceLimits, hasCustomLimits } from '../resource-limits.js';

/** Mode of the progress setting for display, or null for auto. Options are not shown, only that there are some. */
function progressSummary(setting: Job['progress']): string | null {
  if (setting === undefined || setting === 'auto') {
    return null;
  }
  if (typeof setting === 'string') {
    return setting;
  }
  return setting.options === undefined ? setting.strategy : `${setting.strategy} (with options)`;
}

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
  if (!job) {
    return null;
  }
  return (
    <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
      {/* whitespace-pre-wrap keeps the author's line breaks; break-words stops one long token from widening the card. */}
      {job.description && <div><span className={LABEL_CLS}>Description</span><p className="mt-1 text-sm text-content whitespace-pre-wrap break-words">{job.description}</p></div>}
      <div><span className={LABEL_CLS}>Command</span><p className={VALUE_CLS}>{job.command}</p></div>
      {job.cwd && <div><span className={LABEL_CLS}>Working directory</span><p className={VALUE_CLS}>{job.cwd}</p></div>}
      {job.type === 'cron' && job.schedule && <div><span className={LABEL_CLS}>Schedule</span><p className={VALUE_CLS}>{job.schedule}</p></div>}
      {job.type === 'startup' && job.delaySeconds !== undefined && <div><span className={LABEL_CLS}>Startup delay</span><p className="mt-1 text-sm text-content">{job.delaySeconds}s</p></div>}
      {job.type === 'manual' && <div><span className={LABEL_CLS}>Schedule</span><p className="mt-1 text-sm text-content">None: runs only when triggered</p></div>}
      <div><span className={LABEL_CLS}>Trigger mode</span><p className="mt-1 text-sm text-content">{job.triggerMode}</p></div>
      {job.missedFiring && <div><span className={LABEL_CLS}>Missed firing</span><p className="mt-1 text-sm text-content">{job.missedFiring}</p></div>}
      <div><span className={LABEL_CLS}>Timeout</span><p className="mt-1 text-sm text-content">{isLongRunning(job) ? 'Disabled' : `${job.timeoutSeconds ?? 300}s`}</p></div>
      {job.resourceLimits !== undefined && hasCustomLimits(job.resourceLimits) && (
        <div>
          <span className={LABEL_CLS}>Resource limits</span>
          <ul className="mt-1 text-sm text-content">
            {describeResourceLimits(job.resourceLimits).map(line => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
      {progressSummary(job.progress) !== null && <div><span className={LABEL_CLS}>Progress</span><p className="mt-1 text-sm text-content">{progressSummary(job.progress)}</p></div>}
      {job.maxConcurrency !== undefined && <div><span className={LABEL_CLS}>Max concurrent runs</span><p className="mt-1 text-sm text-content">{job.maxConcurrency}</p></div>}
    </div>
  );
}
