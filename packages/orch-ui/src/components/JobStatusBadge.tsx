import React from 'react';
import { Badge } from '@wadeck-app/dsl-ui';

export interface JobStatusBadgeProps {
  exitCode: number | null;
  running?: boolean;
  cancelled?: boolean;
}

/** The five run outcomes this app shows, and the design-system variant each maps to. */
export type JobStatusKind = 'running' | 'ok' | 'failed' | 'cancelled' | 'never';

/**
 * Every status renders at the same visual weight (`tone="subtle"`), so a column of them
 * reads as one set. This file used to export five raw class strings built on
 * `bg-yellow-100 text-yellow-800 dark:...`, which JobCard and RunHistory pasted onto their
 * own spans - a badge geometry maintained in three places.
 *
 * "Running" is info rather than warning: warning is spent on Cancelled, and a run in flight
 * is not a problem. Cancelled keeps amber because it is the one outcome asking for attention
 * without being a failure.
 */
export const JOB_STATUS_VARIANT: Record<JobStatusKind, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  running:   'info',
  ok:        'success',
  failed:    'danger',
  cancelled: 'warning',
  never:     'default',
};

/** Badge for one run outcome, at the shared status weight. */
export function JobStatusPill({ kind, label }: { kind: JobStatusKind; label: string }): React.ReactElement {
  return <Badge variant={JOB_STATUS_VARIANT[kind]} tone="subtle" label={label} />;
}

/**
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
