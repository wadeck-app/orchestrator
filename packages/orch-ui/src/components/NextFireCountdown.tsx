import React from 'react';
import { Tooltip } from '@wadeck-app/dsl-ui';
import { describeCron } from '../cron-describe.js';
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

  const schedule = job.schedule ?? null;
  const described = describeCron(schedule);

  // The dashboard used to print `Cron: 0 10,19 * * *`, asking the reader to parse cron. When
  // the schedule can be phrased, it is - with the expression itself kept in a tooltip for
  // anyone who wants to check it. When it cannot be phrased truthfully, the expression is
  // shown as before rather than guessed at.
  if (described !== null && schedule !== null) {
    return (
      <Tooltip content={schedule}>
        <span className="text-sm text-muted">{described}</span>
      </Tooltip>
    );
  }
  return <span className="text-sm text-muted">Cron: {schedule ?? '-'}</span>;
}
