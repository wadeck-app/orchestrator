import React from 'react';
import type { Job } from '../types.js';
import { isLongRunning } from '../long-running.js';
import { describeRestartOnExit, duration } from '../restart-policy.js';
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

// What the daemon uses when liveness.timeoutSeconds is absent (LIVENESS_COMMAND_TIMEOUT_SECONDS).
const LIVENESS_DEFAULT_TIMEOUT_SECONDS = 30;

/** The log rotation in plain words; null when the job sets nothing (the daemon-wide values apply). */
function describeLogRotation(rotation: Job['logRotation']): string | null {
  if (rotation === undefined || (rotation.maxSizeMb === undefined && rotation.keepSegments === undefined)) {
    return null;
  }
  if (rotation.maxSizeMb === 0) {
    return 'Never rotated: one file per run';
  }
  const size = rotation.maxSizeMb === undefined ? 'the daemon-wide size' : `${rotation.maxSizeMb} MB`;
  const kept = rotation.keepSegments === undefined ? '' : `, newest ${rotation.keepSegments} kept`;
  return `Segments of ${size}${kept}`;
}

/** The retry settings in plain words; null when the job has no exit code to retry on. */
function describeRetries(codes: number[] | undefined, delays: number[] | undefined): string | null {
  if (codes === undefined || codes.length === 0) {
    return null;
  }
  const after = `After exit code ${codes.join(' or ')}`;
  if (delays === undefined || delays.length === 0) {
    return `${after}: no retry configured (retryDelays is empty)`;
  }
  const waits = delays.map((d, i) => (i === 0 ? `waiting ${duration(d)}` : `then ${duration(d)}`)).join(', ');
  return `${after}: ${delays.length} ${delays.length === 1 ? 'retry' : 'retries'}, ${waits}`;
}

/** The liveness check in plain words; null for none. The timeout only exists for the command strategy. */
function describeLiveness(liveness: Job['liveness']): string | null {
  if (!liveness || liveness.strategy === 'none') {
    return null;
  }
  if (liveness.strategy === 'portFile') {
    return `Port file: ${liveness.portFile ?? ''}`;
  }
  if (liveness.strategy === 'pidFile') {
    return 'PID file';
  }
  const timeout = liveness.timeoutSeconds === undefined ? `${LIVENESS_DEFAULT_TIMEOUT_SECONDS} s (default)` : `${liveness.timeoutSeconds} s`;
  return `Command: ${liveness.command ?? ''}, killed after ${timeout}`;
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
  const restart = describeRestartOnExit(job.restartOnExit);
  const rotation = describeLogRotation(job.logRotation);
  const liveness = describeLiveness(job.liveness);
  const retries = describeRetries(job.retryOnExitCodes, job.retryDelays);
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
      {restart !== null && <div><span className={LABEL_CLS}>Restart on exit</span><p className="mt-1 text-sm text-content">{restart}</p></div>}
      {retries !== null && <div><span className={LABEL_CLS}>Retries</span><p className="mt-1 text-sm text-content">{retries}</p></div>}
      {job.skipExitCodes !== undefined && job.skipExitCodes.length > 0 && <div><span className={LABEL_CLS}>Skipped exit codes</span><p className="mt-1 text-sm text-content">{job.skipExitCodes.join(', ')}: recorded as skipped, never counted as a failure</p></div>}
      {rotation !== null && <div><span className={LABEL_CLS}>Log rotation</span><p className="mt-1 text-sm text-content">{rotation}</p></div>}
      {liveness !== null && <div><span className={LABEL_CLS}>Liveness check</span><p className="mt-1 text-sm text-content">{liveness}</p></div>}
      {progressSummary(job.progress) !== null && <div><span className={LABEL_CLS}>Progress</span><p className="mt-1 text-sm text-content">{progressSummary(job.progress)}</p></div>}
      {job.maxConcurrency !== undefined && <div><span className={LABEL_CLS}>Max concurrent runs</span><p className="mt-1 text-sm text-content">{job.maxConcurrency}</p></div>}
    </div>
  );
}
