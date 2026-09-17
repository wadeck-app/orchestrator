import React from 'react';
import { JobStatusPill } from './JobStatusPill.js';

export interface JobStatusBadgeProps {
  exitCode: number | null;
  running?: boolean;
  cancelled?: boolean;
}

/**
 * Turns a run's exit code into the pill that describes it.
 *
 * The pill itself lives in JobStatusPill, which owns the outcome-to-variant mapping. This
 * file used to export five raw class strings that JobCard and RunHistory pasted onto their
 * own spans, so a badge's geometry was maintained in three places.
 *
 * @registryCategory atomic
 * @registryTags badge status job
 */
export function JobStatusBadge({ exitCode, running, cancelled }: JobStatusBadgeProps): React.ReactElement {
  if (running) {
    return <JobStatusPill kind="running" label="Running" />;
  }
  // Must come before the exitCode checks: a killed run has no exit code and would
  // otherwise fall through to "Never run".
  if (cancelled) {
    return <JobStatusPill kind="cancelled" label="Cancelled" />;
  }
  if (exitCode === 0) {
    return <JobStatusPill kind="ok" label="OK" />;
  }
  if (exitCode !== null) {
    return <JobStatusPill kind="failed" label={`Failed - exit ${exitCode}`} />;
  }
  return <JobStatusPill kind="never" label="Never run" />;
}
